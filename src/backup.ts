// 备份/恢复模块: 导出 D1 全量数据 → JSON / R2 快照, 支持导入恢复
import { Context } from 'hono'
import type { Env, BackupData, ApiResponse } from './types'
import { deleteAllSessions, getAdminCredentials } from './storage'

const BACKUP_PREFIX = 'backup/'

/** 验证管理员密码: 从请求头 X-Admin-Auth (SHA-256 哈希) 与存储中的凭据比对 */
async function verifyAdminAuth(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const given = c.req.header('X-Admin-Auth') || ''
  if (!given) return false
  const cred = await getAdminCredentials(c.env)
  if (!cred) return false
  // 恒定时间比较
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(cred.passwordHash)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** 需要管理员密码验证的操作(导出/导入/R2恢复): 失败返回 401 响应, 成功返回 null */
async function requireAdminAuth(c: Context<{ Bindings: Env }>): Promise<Response | null> {
  const ok = await verifyAdminAuth(c)
  if (!ok) {
    return c.json<ApiResponse>({ success: false, message: '管理员密码验证失败' }, 401)
  }
  return null
}

/** 从 D1 导出全量数据(kv_store 配置表 + usage_records 用量表) */
export async function exportBackupData(env: Env): Promise<BackupData> {
  const kv: Array<{ key: string; value: string }> = []
  const usage: BackupData['usage'] = []

  if (env.DB) {
    // D1: 读 kv_store + usage_records 全表 (排除会话 key、管理员凭据、Telegram token, 避免泄露)
    const kvRows = await env.DB.prepare("SELECT key, value FROM kv_store WHERE key NOT LIKE 'admin:session:%' AND key != 'admin:credentials' AND key != 'telegram:backup'").all<{ key: string; value: string }>()
    for (const r of kvRows.results || []) kv.push({ key: r.key, value: r.value })
    const usageRows = await env.DB.prepare(
      'SELECT ts, provider, model, token, ok, status, prompt_tokens, completion_tokens, latency_ms FROM usage_records'
    ).all<BackupData['usage'][number]>()
    for (const r of usageRows.results || []) usage.push(r)
  } else {
    // KV 回退: list 全部 key (排除会话 key 与管理员凭据)
    const store = (await import('./storage-adapter')).getKV(env)
    let cursor: string | undefined
    do {
      const page = await store.list({ cursor })
      for (const k of page.keys) {
        if (k.name.startsWith('admin:session:') || k.name === 'admin:credentials' || k.name === 'telegram:backup') continue
        const v = await store.get(k.name)
        if (v !== null) kv.push({ key: k.name, value: v })
      }
      cursor = page.cursor
    } while (cursor)
  }

  return { version: 1, exportedAt: new Date().toISOString(), kv, usage }
}

/** 全量写入: 清空后写入 kv(配置) + usage(用量); 保留管理员凭据; 写完强制登出所有会话。
 *  导入/恢复后用户需重新登录, 登录成功时凭据会重新写入存储。 */
async function importBackupData(env: Env, data: BackupData): Promise<{ kv: number; usage: number }> {
  const kv = Array.isArray(data.kv) ? data.kv : []
  const usage = Array.isArray(data.usage) ? data.usage : []

  if (env.DB) {
    // 清空现有数据 (保留会话 key、管理员凭据与 Telegram 配置)
    await env.DB.prepare("DELETE FROM kv_store WHERE key NOT LIKE 'admin:session:%' AND key != 'admin:credentials' AND key != 'telegram:backup'").run()
    await env.DB.prepare('DELETE FROM usage_records').run()
    // 批量写入 kv
    const kvStmt = env.DB.prepare('INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)')
    const kvBatch = kv.map((r) => kvStmt.bind(r.key, r.value))
    if (kvBatch.length > 0) await env.DB.batch(kvBatch)
    // 批量写入 usage
    const uStmt = env.DB.prepare(
      'INSERT OR REPLACE INTO usage_records (ts, provider, model, token, ok, status, prompt_tokens, completion_tokens, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const uBatch = usage.map((r) =>
      uStmt.bind(r.ts, r.provider, r.model, r.token || '', Number(r.ok) || 0, Number(r.status) || 0, Number(r.prompt_tokens) || 0, Number(r.completion_tokens) || 0, Number(r.latency_ms) || 0)
    )
    if (uBatch.length > 0) await env.DB.batch(uBatch)
  } else {
    // KV 回退: 只恢复配置类数据(会话/用量记录用 KV 前缀, 一并写入)
    const store = (await import('./storage-adapter')).getKV(env)
    // 先列出旧 key 删除(避免残留, 保留会话 key 与凭据), 再写入
    let cursor: string | undefined
    do {
      const page = await store.list({ cursor })
      for (const k of page.keys) {
        if (!k.name.startsWith('admin:session:') && k.name !== 'admin:credentials' && k.name !== 'telegram:backup') await store.delete(k.name)
      }
      cursor = page.cursor
    } while (cursor)
    for (const r of kv) {
      if (r.key.startsWith('admin:session:') || r.key === 'admin:credentials' || r.key === 'telegram:backup') continue
      await store.put(r.key, r.value)
    }
  }

  // 强制登出所有会话: 导入/恢复可能改变数据, 要求重新登录(登录时凭据会重新写入)
  await deleteAllSessions(env)

  return { kv: kv.length, usage: usage.length }
}

/** 导出(JSON 下载) — 需管理员密码验证 */
export async function handleBackupExport(c: Context<{ Bindings: Env }>) {
  const authRes = await requireAdminAuth(c)
  if (authRes) return authRes
  try {
    const data = await exportBackupData(c.env)
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="ai-gateway-backup-${data.exportedAt.slice(0, 10)}.json"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json<ApiResponse>({ success: false, message: `导出失败: ${message}` }, 500)
  }
}

/** 导入(JSON 恢复): 覆盖现有配置与用量 — 需管理员密码验证 */
export async function handleBackupImport(c: Context<{ Bindings: Env }>) {
  const authRes = await requireAdminAuth(c)
  if (authRes) return authRes
  try {
    const raw = await c.req.text()
    const data = JSON.parse(raw) as BackupData
    if (!data || !Array.isArray(data.kv)) {
      return c.json<ApiResponse>({ success: false, message: '无效的备份文件' }, 400)
    }
    const result = await importBackupData(c.env, data)
    return c.json<ApiResponse>({ success: true, message: `导入完成: ${result.kv} 条配置, ${result.usage} 条用量` })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json<ApiResponse>({ success: false, message: `导入失败: ${message}` }, 500)
  }
}

/** 备份到 R2: 存一份带时间戳的快照, 最多保留 30 份 */
export async function handleBackupToR2(c: Context<{ Bindings: Env }>) {
  const bucket = c.env.ai_gateway_backup
  if (!bucket) return c.json<ApiResponse>({ success: false, message: 'R2 未配置(binding: ai_gateway_backup)' }, 400)
  try {
    const data = await exportBackupData(c.env)
    const key = `${BACKUP_PREFIX}${data.exportedAt.replace(/[:.]/g, '-')}.json`
    await bucket.put(key, JSON.stringify(data), {
      httpMetadata: { contentType: 'application/json' },
    })
    // 清理: 只保留最新 30 份
    const all = await bucket.list({ prefix: BACKUP_PREFIX })
    if (all.objects.length > 30) {
      const sorted = all.objects.sort((a, b) => (a.uploaded > b.uploaded ? -1 : 1))
      for (const old of sorted.slice(30)) await bucket.delete(old.key)
    }
    return c.json<ApiResponse>({ success: true, message: `已备份到 R2: ${key}` })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json<ApiResponse>({ success: false, message: `备份失败: ${message}` }, 500)
  }
}

/** 列出 R2 中的备份快照 */
export async function handleBackupList(c: Context<{ Bindings: Env }>) {
  const bucket = c.env.ai_gateway_backup
  if (!bucket) return c.json<ApiResponse>({ success: false, message: 'R2 未配置(binding: ai_gateway_backup)' }, 400)
  const all = await bucket.list({ prefix: BACKUP_PREFIX })
  const files = all.objects
    .sort((a, b) => (a.uploaded > b.uploaded ? -1 : 1))
    .map((o) => ({
      key: o.key,
      size: o.size,
      uploaded: o.uploaded.toISOString(),
    }))
  return c.json<ApiResponse>({ success: true, data: files })
}

/** 从 R2 恢复: 读取最新一份快照并覆盖写入 — 需管理员密码验证 */
export async function handleBackupRestore(c: Context<{ Bindings: Env }>) {
  const authRes = await requireAdminAuth(c)
  if (authRes) return authRes
  const bucket = c.env.ai_gateway_backup
  if (!bucket) return c.json<ApiResponse>({ success: false, message: 'R2 未配置(binding: ai_gateway_backup)' }, 400)
  try {
    const body = await c.req.json<{ key?: string }>().catch(() => ({} as { key?: string }))
    const all = await bucket.list({ prefix: BACKUP_PREFIX })
    if (all.objects.length === 0) return c.json<ApiResponse>({ success: false, message: 'R2 中没有备份快照' }, 404)
    const sorted = all.objects.sort((a, b) => (a.uploaded > b.uploaded ? -1 : 1))
    const target = body.key ? sorted.find((o) => o.key === body.key) : sorted[0]
    if (!target) return c.json<ApiResponse>({ success: false, message: '指定的快照不存在' }, 404)
    const obj = await bucket.get(target.key)
    if (!obj) return c.json<ApiResponse>({ success: false, message: '快照读取失败' }, 500)
    const data = JSON.parse(await obj.text()) as BackupData
    if (!data || !Array.isArray(data.kv)) return c.json<ApiResponse>({ success: false, message: '快照数据无效' }, 400)
    const result = await importBackupData(c.env, data)
    return c.json<ApiResponse>({ success: true, message: `已从 ${target.key} 恢复: ${result.kv} 条配置, ${result.usage} 条用量` })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json<ApiResponse>({ success: false, message: `恢复失败: ${message}` }, 500)
  }
}

/** 删除 R2 中的指定快照 — 需管理员密码验证 */
export async function handleBackupDelete(c: Context<{ Bindings: Env }>) {
  const authRes = await requireAdminAuth(c)
  if (authRes) return authRes
  const bucket = c.env.ai_gateway_backup
  if (!bucket) return c.json<ApiResponse>({ success: false, message: 'R2 未配置(binding: ai_gateway_backup)' }, 400)
  const body = await c.req.json<{ key: string }>().catch(() => ({ key: '' }))
  if (!body.key) return c.json<ApiResponse>({ success: false, message: '缺少 key 参数' }, 400)
  await bucket.delete(body.key)
  return c.json<ApiResponse>({ success: true, message: '快照已删除' })
}

// ===== Telegram 备份 =====

const TELEGRAM_CONFIG_KEY = 'telegram:backup'

export interface TelegramConfig {
  botToken: string
  chatId: string
}

/** 读取 Telegram 备份配置 */
export async function getTelegramConfig(env: Env): Promise<TelegramConfig | null> {
  const store = (await import('./storage-adapter')).getKV(env)
  const data = await store.get(TELEGRAM_CONFIG_KEY)
  if (!data) return null
  try {
    return JSON.parse(data) as TelegramConfig
  } catch {
    return null
  }
}

/** 保存 Telegram 备份配置 */
async function setTelegramConfig(env: Env, cfg: TelegramConfig): Promise<void> {
  const store = (await import('./storage-adapter')).getKV(env)
  await store.put(TELEGRAM_CONFIG_KEY, JSON.stringify(cfg))
}

/** 从请求体或存储配置解析 Telegram 参数 */
async function resolveTelegramParams(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ botToken?: string; chatId?: string }>().catch(() => ({ botToken: '', chatId: '' }))
  let botToken = (body.botToken || '').trim()
  let chatId = (body.chatId || '').trim()
  if (!botToken || !chatId) {
    const stored = await getTelegramConfig(c.env)
    if (stored) {
      if (!botToken) botToken = stored.botToken
      if (!chatId) chatId = stored.chatId
    }
  }
  return { botToken, chatId }
}

/** 调用 Telegram Bot API: 发送消息 */
async function tgSendMessage(botToken: string, chatId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    const d = (await r.json()) as { ok?: boolean; description?: string }
    if (!r.ok || !d.ok) return { ok: false, error: d.description || `HTTP ${r.status}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 调用 Telegram Bot API: 发送文档(JSON 备份文件) */
async function tgSendDocument(botToken: string, chatId: string, filename: string, content: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const form = new FormData()
    form.append('chat_id', chatId)
    form.append('document', new Blob([content], { type: 'application/json' }), filename)
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: 'POST', body: form })
    const d = (await r.json()) as { ok?: boolean; description?: string }
    if (!r.ok || !d.ok) return { ok: false, error: d.description || `HTTP ${r.status}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 测试 Telegram 备份通道: 发送测试消息; 成功则保存配置 */
export async function handleTelegramTest(c: Context<{ Bindings: Env }>) {
  const { botToken, chatId } = await resolveTelegramParams(c)
  if (!botToken || !chatId) {
    return c.json<ApiResponse>({ success: false, message: '请填写 Telegram Bot Token 和 USER ID' }, 400)
  }
  const result = await tgSendMessage(botToken, chatId, `✅ AI Gateway 备份通道测试成功\n时间: ${new Date().toISOString()}`)
  if (!result.ok) {
    return c.json<ApiResponse>({ success: false, message: `发送失败: ${result.error || '未知错误'}` }, 400)
  }
  // 测试成功才保存配置
  await setTelegramConfig(c.env, { botToken, chatId })
  return c.json<ApiResponse>({ success: true, message: '测试消息发送成功，配置已保存' })
}

/** 备份到 Telegram: 导出数据 → 发送 JSON 文件 + 摘要消息; 发送成功才算备份成功 */
export async function handleBackupToTelegram(c: Context<{ Bindings: Env }>) {
  const { botToken, chatId } = await resolveTelegramParams(c)
  if (!botToken || !chatId) {
    return c.json<ApiResponse>({ success: false, message: '请填写 Telegram Bot Token 和 USER ID' }, 400)
  }
  try {
    const data = await exportBackupData(c.env)
    const json = JSON.stringify(data, null, 2)
    const filename = `ai-gateway-backup-${data.exportedAt.slice(0, 10)}.json`
    const fileResult = await tgSendDocument(botToken, chatId, filename, json)
    if (!fileResult.ok) {
      return c.json<ApiResponse>({ success: false, message: `文件发送失败: ${fileResult.error || '未知错误'}` }, 400)
    }
    const summary = `🗂 AI Gateway 备份完成\n时间: ${data.exportedAt}\n配置项: ${data.kv.length} 条\n用量记录: ${data.usage.length} 条\n文件: ${filename}`
    const msgResult = await tgSendMessage(botToken, chatId, summary)
    if (!msgResult.ok) {
      return c.json<ApiResponse>({ success: false, message: `文件已发送但摘要失败: ${msgResult.error || '未知错误'}` }, 500)
    }
    return c.json<ApiResponse>({ success: true, message: '已备份到 Telegram(文件+摘要)' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json<ApiResponse>({ success: false, message: `备份失败: ${message}` }, 500)
  }
}
