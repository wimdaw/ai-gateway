/**
 * 存储适配层：统一使用 Cloudflare D1。
 * 
 * 用量统计走 D1 usage_records 表 SQL 聚合。
 * KV 兼容接口由 D1 kv_store 表实现。
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

/** D1 存储实现（kv_store 表） */
function d1KVImpl(db: D1Database): KVLike {
  return {
    async get(key) {
      const res = await db.prepare('SELECT value, expires_at FROM kv_store WHERE key = ?').bind(key).first<{ value: string; expires_at: number | null }>()
      if (!res) return null
      // 检查是否过期（expires_at 为 Unix 秒，null 表示永不过期）
      if (res.expires_at !== null && res.expires_at < Math.floor(Date.now() / 1000)) {
        await db.prepare('DELETE FROM kv_store WHERE key = ?').bind(key).run().catch(() => {})
        return null
      }
      return res.value
    },
    async put(key, value, options) {
      const expiresAt = options?.expirationTtl
        ? Math.floor(Date.now() / 1000) + options.expirationTtl
        : null
      await db.prepare(
        'INSERT INTO kv_store (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
      ).bind(key, value, expiresAt).run()
    },
    async delete(key) {
      await db.prepare('DELETE FROM kv_store WHERE key = ?').bind(key).run()
    },
    async list(options) {
      const prefix = options?.prefix ?? ''
      const now = Math.floor(Date.now() / 1000)
      const limit = 1000

      let query = 'SELECT key FROM kv_store WHERE key LIKE ? AND (expires_at IS NULL OR expires_at > ?)'
      const binds: any[] = [prefix + '%', now]

      if (options?.cursor) {
        query += ' AND key > ?'
        binds.push(options.cursor)
      }
      
      query += ' ORDER BY key ASC LIMIT ?'
      binds.push(limit)

      const res = await db.prepare(query).bind(...binds).all<{ key: string }>()
      const results = res.results || []

      return {
        keys: results.map((r) => ({ name: r.key })),
        list_complete: results.length < limit,
        cursor: results.length === limit ? results[results.length - 1].key : undefined,
      }
    },
  }
}

/** 获取 KV 兼容实例 */
export function getKV(env: any): KVLike {
  if (!env.DB) throw new Error('Missing DB binding')
  return d1KVImpl(env.DB)
}

/**
 * 返回当前实际生效的存储类型
 */
export function getStorageType(_env: any): 'd1' {
  return 'd1'
}

/** 存储类型的中文展示名 */
export function storageTypeLabel(_env: any): string {
  return 'D1 数据库'
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
      db.prepare('CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER DEFAULT NULL)'),
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
      db.prepare('CREATE INDEX IF NOT EXISTS idx_kv_store_expires ON kv_store(expires_at) WHERE expires_at IS NOT NULL'),
    ])
  } catch (e) {
    console.error('ensureD1Tables create error:', (e as Error).message)
  }

  try {
    // 独立执行 ALTER，避免其静默报错导致整个 batch 事务回滚
    await db.prepare('ALTER TABLE kv_store ADD COLUMN expires_at INTEGER DEFAULT NULL').run()
  } catch (e) { /* ignore expected duplicate column error */ }

  d1Initialized = true
}
