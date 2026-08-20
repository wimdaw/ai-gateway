import { getStore } from '@edgeone/pages-blob'

/**
 * 存储适配层：统一 Cloudflare KV / D1 / EdgeOne Pages Blob 的接口。
 *
 * Cloudflare 版：优先 env.DB (D1)，不存在时回退 env.KV (KVNamespace)
 * EdgeOne 版：getStore("ai-gateway")（Pages Blob，函数内自动鉴权）
 *
 * D1 实现：kv_store 表 (key TEXT PRIMARY KEY, value TEXT)，
 * 兼容全部现有 KV key 用法；用量统计走 usage_records 表 SQL 聚合。
 */

export interface KVLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>
    cursor?: string
    list_complete: boolean
  }>
}

/** 平台标记：由构建入口注入 */
export type Platform = 'cloudflare' | 'edgeone'

let platform: Platform = 'cloudflare'
let blobStore: ReturnType<typeof getStore> | null = null
/** 内存兜底：Blob 初始化失败或不可用时使用（进程内有效，不跨实例） */
let memoryStore: Map<string, string> | null = null

export function initStorage(p: Platform): void {
  platform = p
  if (p === 'edgeone') {
    try {
      blobStore = getStore('ai-gateway')
    } catch (err) {
      // Pages Blob 凭据缺失/初始化失败 → 降级内存存储，避免全站 500
      console.error('[storage-adapter] Pages Blob 初始化失败，降级内存存储:', err)
      blobStore = null
      memoryStore = memoryStore || new Map()
    }
  }
}

/** 内存兜底 KV 实现 */
function memoryKVImpl(): KVLike {
  const store = memoryStore || (memoryStore = new Map())
  return {
    async get(key) {
      return store.get(key) ?? null
    },
    async put(key, value, _options) {
      store.set(key, value)
    },
    async delete(key) {
      store.delete(key)
    },
    async list(options) {
      const prefix = options?.prefix ?? ''
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }))
      return { keys, cursor: undefined, list_complete: true }
    },
  }
}

/** D1 存储实现（kv_store 表） */
function d1KVImpl(db: D1Database): KVLike {
  return {
    async get(key) {
      const res = await db.prepare('SELECT value FROM kv_store WHERE key = ?').bind(key).first<{ value: string }>()
      return res ? res.value : null
    },
    async put(key, value) {
      await db.prepare('INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run()
    },
    async delete(key) {
      await db.prepare('DELETE FROM kv_store WHERE key = ?').bind(key).run()
    },
    async list(options) {
      const prefix = options?.prefix ?? ''
      const res = await db.prepare('SELECT key FROM kv_store WHERE key LIKE ? ORDER BY key LIMIT 1000').bind(prefix + '%').all<{ key: string }>()
      return {
        keys: (res.results || []).map((r) => ({ name: r.key })),
        cursor: undefined,
        list_complete: true,
      }
    },
  }
}

/** 获取 KV 兼容实例（Cloudflare 优先 D1，回退 KV；EdgeOne 用内部 Blob store，失败时内存兜底） */
export function getKV(env: any): KVLike {
  if (platform === 'edgeone') {
    if (blobStore) {
      return {
        async get(key) {
          return blobStore!.get(key)
        },
        async put(key, value, _options) {
          await blobStore!.set(key, value)
        },
        async delete(key) {
          await blobStore!.delete(key)
        },
        async list(options) {
          const res = await blobStore!.list({
            prefix: options?.prefix,
            cursor: options?.cursor,
            paginate: false,
            limit: 1000,
          })
          return {
            keys: res.blobs.map((b) => ({ name: b.key })),
            cursor: res.cursor,
            list_complete: !res.cursor,
          }
        },
      }
    }
    // Blob 不可用 → 内存兜底（进程内）
    return memoryKVImpl()
  }
  // Cloudflare 版：优先 D1（新存储），回退 KV（旧存储/兼容）
  if (env.DB) {
    return d1KVImpl(env.DB)
  }
  return env.KV as KVLike
}

/**
 * 返回当前实际生效的存储类型: 'd1' | 'kv' | 'blob' | 'memory'
 * Cloudflare 版: 优先 env.DB (D1), 回退 env.KV
 * EdgeOne 版: Pages Blob, 失败时内存兜底
 */
export function getStorageType(env: any): 'd1' | 'kv' | 'blob' | 'memory' {
  if (platform === 'edgeone') {
    return blobStore ? 'blob' : 'memory'
  }
  if (env.DB) return 'd1'
  if (env.KV) return 'kv'
  return 'memory'
}

/** 存储类型的中文展示名 */
export function storageTypeLabel(env: any): string {
  const t = getStorageType(env)
  switch (t) {
    case 'd1': return 'D1 数据库'
    case 'kv': return 'Cloudflare KV'
    case 'blob': return 'EdgeOne Blob'
    case 'memory': return '内存(临时)'
  }
}

/** 供 EdgeOne 版手动清理过期用量记录（Blob 无 TTL） */
export async function cleanupUsageRecords(env: any, retentionDays: number): Promise<number> {
  if (platform !== 'edgeone' || !blobStore) return 0
  const cutoff = Date.now() - retentionDays * 86400000
  const cutoffStr = new Date(cutoff).toISOString().slice(0, 10)
  const prefix = 'usage:req:'
  let deleted = 0
  let cursor: string | undefined
  for (;;) {
    const page = await blobStore!.list({ prefix, cursor, paginate: false, limit: 1000 })
    for (const b of page.blobs) {
      // key 形如 usage:req:YYYY-MM-DD:uuid
      const datePart = b.key.split(':')[2]
      if (datePart && datePart < cutoffStr) {
        await blobStore!.delete(b.key).catch(() => {})
        deleted++
      }
    }
    if (!page.cursor) break
    cursor = page.cursor
  }
  return deleted
}

/** 用量记录 D1 直写（独立行，SQL 聚合） */
export async function addUsageRecordD1(db: D1Database, record: {
  ts: string
  provider: string
  model: string
  token: string
  ok: boolean
  status: number
  promptTokens: number
  completionTokens: number
  latencyMs: number
}): Promise<void> {
  await db.prepare(
    'INSERT INTO usage_records (ts, provider, model, token, ok, status, prompt_tokens, completion_tokens, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    record.ts,
    record.provider,
    record.model,
    record.token,
    record.ok ? 1 : 0,
    record.status,
    record.promptTokens || 0,
    record.completionTokens || 0,
    record.latencyMs || 0,
  ).run().catch(() => {})
}
