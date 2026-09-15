// 一次性迁移脚本: 将 KV 中现有数据全部迁入 D1
// 访问 /admin/migrate-kv-to-d1 触发 (需 admin session)
import { getKV } from './storage-adapter'
import type { Env } from './types'

export async function handleMigrateKvToD1(c: any): Promise<Response> {
  const env = c.env as Env
  if (!env.DB) {
    return c.json({ success: false, message: '需要 D1 数据库绑定 (DB)' })
  }
  if (!env.KV) {
    return c.json({
      success: true,
      message: '当前为 Pages + D1 纯净部署，无 KV 存储，无需执行迁移。所有数据已直接存储在 D1 中。',
      data: { migrated: {}, errors: [], errorCount: 0 },
    })
  }
  const kv = getKV(env) // D1 优先! 这里必须直接读 KV
  const results: Record<string, number> = {}
  const errors: string[] = []

  // 1. providers / proxy keys / sessions / migration 标志 (整块 KV key)
  const blockKeys = ['providers', 'proxy:keys', 'migration:opencode-default:v1']
  for (const key of blockKeys) {
    const raw = await env.KV.get(key).catch(() => null)
    if (raw === null) continue
    await env.DB.prepare('INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, raw).run()
    results[key] = 1
  }

  // 2. sessions (admin:session:*)
  const sessionKeys = await listAllKvKeys(env, 'admin:session:')
  for (const key of sessionKeys) {
    const raw = await env.KV.get(key).catch(() => null)
    if (raw === null) continue
    await env.DB.prepare('INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, raw).run()
    results[key] = 1
  }

  // 3. key health (key:health:*)
  const healthKeys = await listAllKvKeys(env, 'key:health:')
  for (const key of healthKeys) {
    const raw = await env.KV.get(key).catch(() => null)
    if (raw === null) continue
    await env.DB.prepare('INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, raw).run()
    results[key] = 1
  }

  // 4. usage records (usage:req:*)
  const usageKeys = await listAllKvKeys(env, 'usage:req:')
  let usageMigrated = 0
  for (const key of usageKeys) {
    const raw = await env.KV.get(key).catch(() => null)
    if (raw === null) continue
    try {
      const r = JSON.parse(raw)
      await env.DB.prepare(
        'INSERT INTO usage_records (ts, provider, model, token, ok, status, prompt_tokens, completion_tokens, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        r.ts || '',
        r.provider || '',
        r.model || '',
        r.token || '',
        r.ok ? 1 : 0,
        r.status || 0,
        r.promptTokens || 0,
        r.completionTokens || 0,
        r.latencyMs || 0,
      ).run()
      usageMigrated++
    } catch (e) {
      errors.push(`usage ${key}: ${(e as Error).message}`)
    }
  }
  results['usage:req:*'] = usageMigrated

  // 5. 标记迁移完成
  await env.DB.prepare('INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('migration:kv-to-d1:v1', 'done').run()

  return c.json({ success: true, data: { migrated: results, errors: errors.slice(0, 20), errorCount: errors.length } })
}

/** 分页读取 KV 全部 key */
async function listAllKvKeys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  for (let i = 0; i < 100; i++) {
    const page = await env.KV.list({ prefix, cursor })
    for (const k of page.keys) keys.push(k.name)
    if (page.list_complete) break
    cursor = page.cursor
  }
  return keys
}
