/**
 * Antigravity 管理端接口：授权、模型、账号、额度。
 */
import { Context } from 'hono'
import { ok, fail } from '../http'
import { getProviders } from '../storage'
import { buildAntigravityAuthUrl, exchangeAntigravityCode, fetchAntigravityModels, fetchAntigravityQuota } from '../antigravity'
import type { Env, ApiResponse } from '../types'

// ===== Antigravity 内置 OAuth 授权 + 可用模型 =====

export async function handleAntigravityOAuthStart(c: Context<{ Bindings: Env }>) {
  try {
    const { url, state } = await buildAntigravityAuthUrl(c.env)
    return ok(c, { url, state })
  } catch (err) {
    return fail(c, (err as Error).message || '生成授权链接失败', 500)
  }
}

export async function handleAntigravityOAuthComplete(c: Context<{ Bindings: Env }>) {
  const { code, state } = await c.req.json<{ code?: string; state?: string }>()
  if (!code || !state) {
    return fail(c, 'code、state 为必填项', 400)
  }
  try {
    const { refreshToken } = await exchangeAntigravityCode(c.env, code, state)
    return ok(c, { refresh_token: refreshToken })
  } catch (err) {
    return fail(c, (err as Error).message || '换取 token 失败', 400)
  }
}

/** 拉取 Antigravity 可用模型列表（用于回填模型配置） */
export async function handleAntigravityModels(c: Context<{ Bindings: Env }>) {
  const { apiKey } = await c.req.json<{ apiKey?: string }>()
  if (!apiKey) {
    return fail(c, '请先填写 refresh_token', 400)
  }
  const r = await fetchAntigravityModels(c.env, apiKey)
  return c.json<ApiResponse<{ models: string[]; message?: string; raw?: unknown }>>({
    success: r.success,
    data: { models: r.models, message: r.message, raw: r.raw },
    message: r.message,
  })
}

/** 返回 Antigravity 渠道/账号清单（不调用 Google，供「刷新账号」用） */
export async function handleAntigravityAccounts(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const channels = providers
    .filter((p) => (p.type || '') === 'antigravity' && p.enabled)
    .map((p) => ({
      id: p.id,
      name: p.name,
      accountCount: p.apiKeys.filter((k) => k.enabled && k.key && k.key.trim()).length,
    }))
  return ok(c, { channels })
}

/** 查询 Antigravity 额度（侧边栏「额度」用，凭据在服务端读取）
 *  - 空 body：返回所有已启用渠道的全部账号
 *  - { channelId, index }：只返回该渠道指定账号（账号级「查询」按钮用）
 */
export async function handleAntigravityQuotaAll(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ channelId?: string; index?: number }>().catch(() => ({} as { channelId?: string; index?: number }))
  const providers = await getProviders(c.env)
  const ags = providers.filter((p) => (p.type || '') === 'antigravity' && p.enabled)

  // 单账号查询
  if (body.channelId) {
    const p = ags.find((x) => x.id === body.channelId)
    if (!p) return fail(c, `渠道 "${body.channelId}" 不存在`, 404)
    const keys = p.apiKeys.filter((k) => k.enabled).map((k) => k.key).filter((k) => k && k.trim())
    const idx = Math.max(0, Number(body.index) || 0)
    if (!keys[idx]) return fail(c, `该渠道第 ${idx + 1} 个账号不存在`, 404)
    const accounts = await fetchAntigravityQuota(c.env, [keys[idx]], p.project)
    if (accounts[0]) accounts[0].index = idx
    return ok(c, { accounts })
  }

  // 全部渠道
  const channels: Array<{ id: string; name: string; accounts: unknown[] }> = []
  for (const p of ags) {
    const keys = p.apiKeys.filter((k) => k.enabled).map((k) => k.key).filter((k) => k && k.trim())
    if (keys.length === 0) {
      channels.push({ id: p.id, name: p.name, accounts: [] })
      continue
    }
    const accounts = await fetchAntigravityQuota(c.env, keys, p.project)
    channels.push({ id: p.id, name: p.name, accounts })
  }
  return ok(c, { channels })
}

