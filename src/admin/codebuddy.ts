/**
 * CodeBuddy 账号状态（积分 / 套餐余额）。
 */
import { Context } from 'hono'
import { ok, fail } from '../http'
import { getProvider } from '../storage'
import { fetchCodebuddyStatus } from '../codebuddy'
import type { Env, ApiResponse } from '../types'

// ===== CodeBuddy 账号状态（积分/套餐余额） =====

/**
 * 查询 codebuddy 渠道的账号状态。
 * 支持两种入参：传 providerId（取该渠道第 index 个启用凭据）+ baseUrl + region；
 * 或直接传 refreshToken / baseUrl / region（新增渠道尚未保存时用表单里的值）。
 */
export async function handleCodebuddyStatus(c: Context<{ Bindings: Env }>) {
  type CbStatusBody = { refreshToken?: string; providerId?: string; baseUrl?: string; region?: string; index?: number }
  const body = await c.req.json<CbStatusBody>().catch(() => ({} as CbStatusBody))
  let refreshToken = (body.refreshToken || '').trim()
  let baseUrl = body.baseUrl || ''
  let region = body.region
  if (!refreshToken && body.providerId) {
    const provider = await getProvider(c.env, body.providerId)
    if (!provider) return fail(c, `渠道 "${body.providerId}" 不存在`, 404)
    const keys = provider.apiKeys.filter((k) => k.enabled)
    const idx = Number.isInteger(body.index) ? (body.index as number) : 0
    refreshToken = (keys[idx]?.key || '').trim()
    baseUrl = baseUrl || provider.baseUrl
    region = region || provider.region
  }
  if (!refreshToken) {
    return fail(c, '请先填写 refresh_token，或先保存渠道再查询', 400)
  }
  const r = await fetchCodebuddyStatus(c.env, refreshToken, baseUrl, region)
  return c.json<ApiResponse<typeof r>>({ success: r.ok, data: r, message: r.message })
}

