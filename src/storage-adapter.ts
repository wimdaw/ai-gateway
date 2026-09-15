/**
 * 存储适配层：统一 Cloudflare D1 / KV 的接口。
 *
 * 优先 env.DB (D1)，不存在时回退 env.KV (KVNamespace)；两者都不可用时降级内存（进程内，不跨实例）。
 * 用量统计走 D1 usage_records 表 SQL 聚合。
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

/** 内存兜底：未绑定 D1/KV 时使用（进程内有效，不跨实例） */
let memoryStore: Map<string, string> | null = null

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

/** 获取 KV 兼容实例（优先 D1，其次 KV，最后内存兜底） */
export function getKV(env: any): KVLike {
  if (env.DB) return d1KVImpl(env.DB)
  if (env.KV) return env.KV as KVLike
  return memoryKVImpl()
}

/**
 * 返回当前实际生效的存储类型: 'd1' | 'kv' | 'memory'
 */
export function getStorageType(env: any): 'd1' | 'kv' | 'memory' {
  if (env.DB) return 'd1'
  if (env.KV) return 'kv'
  return 'memory'
}

/** 存储类型的中文展示名 */
export function storageTypeLabel(env: any): string {
  switch (getStorageType(env)) {
    case 'd1': return 'D1 数据库'
    case 'kv': return 'Cloudflare KV'
    case 'memory': return '内存(临时)'
  }
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

let d1Initialized = false

/** 确保 D1 基础表结构存在（首次访问或冷启动容错） */
export async function ensureD1Tables(db: D1Database): Promise<void> {
  if (d1Initialized) return
  try {
    await db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS usage_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        token TEXT,
        ok INTEGER DEFAULT 1,
        status INTEGER DEFAULT 200,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        latency_ms REAL DEFAULT 0
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_usage_records_ts ON usage_records(ts)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_usage_records_model ON usage_records(model)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_usage_records_provider ON usage_records(provider)'),
    ])
    d1Initialized = true
  } catch (e) {
    console.error('ensureD1Tables failed:', e)
  }
}
