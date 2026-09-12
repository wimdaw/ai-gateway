/**
 * Kimi (Moonshot) OAuth 反代 (provider.type = 'kimi')
 *
 * 复刻 CLIProxyAPI 的 Kimi OAuth + executor：
 *  1. RFC 8628 设备码授权：POST auth.kimi.com/api/oauth/device_authorization 拿
 *     verification_uri + user_code，用户在浏览器确认后轮询 /api/oauth/token 换 token
 *  2. 上游 api.kimi.com/coding/v1/chat/completions 为 OpenAI 兼容协议，
 *     Bearer access_token 直连，请求/响应原样透传（仅归一化模型名）
 *  3. 模型别名归一化：kimi-k2.x / k2.x-code -> kimi-for-coding（与 CLIProxyAPI 一致）
 *
 * 渠道 apiKeys 里每行一个 Kimi OAuth refresh_token。
 */

import type { Env } from './types'
import { getKV } from './storage-adapter'
import {
  type OAuthCallParams,
  oauthErrorResponse,
  randomId,
  readErrorBody,
  recordOAuthUsage,
  defer,
  resolveAccessToken,
} from './oauth-common'

const KIMI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'
const KIMI_DEVICE_URL = 'https://auth.kimi.com/api/oauth/device_authorization'
const KIMI_TOKEN_URL = 'https://auth.kimi.com/api/oauth/token'
const KIMI_API_BASE = 'https://api.kimi.com/coding'

const AT_PREFIX = 'kimi:at:'
const DEVICE_PREFIX = 'kimi:device:'

// ===== 设备码流程请求头（与 CLIProxyAPI 一致） =====
function mshHeaders(deviceId: string): Record<string, string> {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
    'X-Msh-Platform': 'CLIProxyAPI',
    'X-Msh-Version': '2.9.1',
    'X-Msh-Device-Name': 'ai-gateway',
    'X-Msh-Device-Model': 'Cloudflare Workers',
    'X-Msh-Device-Id': deviceId,
  }
}

// =====================================================================
// 设备码授权（开始 / 轮询）
// =====================================================================

export interface KimiDeviceFlow {
  state: string
  verificationUri: string
  verificationUriComplete?: string
  userCode: string
  expiresIn: number
  interval: number
}

export async function startKimiDeviceFlow(env: Env): Promise<KimiDeviceFlow> {
  const deviceId = randomId()
  const form = new URLSearchParams({ client_id: KIMI_CLIENT_ID })
  const res = await fetch(KIMI_DEVICE_URL, {
    method: 'POST',
    headers: mshHeaders(deviceId),
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { throw new Error(`设备码请求返回非 JSON: ${text.slice(0, 200)}`) }
  if (!res.ok || !json.device_code) throw new Error(`设备码请求失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
  const state = randomId()
  await getKV(env).put(DEVICE_PREFIX + state, JSON.stringify({
    deviceCode: json.device_code,
    deviceId,
  }), { expirationTtl: Math.max(300, Number(json.expires_in) || 900) }).catch(() => {})
  return {
    state,
    verificationUri: String(json.verification_uri || 'https://auth.kimi.com/device'),
    verificationUriComplete: json.verification_uri_complete ? String(json.verification_uri_complete) : undefined,
    userCode: String(json.user_code || ''),
    expiresIn: Number(json.expires_in) || 900,
    interval: Number(json.interval) || 5,
  }
}

export interface KimiPollResult {
  status: 'pending' | 'ok' | 'error'
  message?: string
  refreshToken?: string
}

export async function pollKimiDeviceFlow(env: Env, state: string): Promise<KimiPollResult> {
  const raw = await getKV(env).get(DEVICE_PREFIX + state)
  if (!raw) return { status: 'error', message: '设备码会话不存在或已过期，请重新发起授权' }
  const { deviceCode, deviceId } = JSON.parse(raw) as { deviceCode: string; deviceId: string }
  const form = new URLSearchParams({
    client_id: KIMI_CLIENT_ID,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })
  const res = await fetch(KIMI_TOKEN_URL, {
    method: 'POST',
    headers: mshHeaders(deviceId),
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { return { status: 'error', message: `轮询返回非 JSON: ${text.slice(0, 200)}` } }
  if (json.error) {
    if (json.error === 'authorization_pending' || json.error === 'slow_down') return { status: 'pending' }
    if (json.error === 'expired_token') {
      await getKV(env).delete(DEVICE_PREFIX + state).catch(() => {})
      return { status: 'error', message: '设备码已过期，请重新发起授权' }
    }
    if (json.error === 'access_denied') {
      await getKV(env).delete(DEVICE_PREFIX + state).catch(() => {})
      return { status: 'error', message: '用户拒绝了授权' }
    }
    return { status: 'error', message: `Kimi OAuth 错误: ${json.error} ${json.error_description || ''}`.trim() }
  }
  if (!json.access_token) return { status: 'error', message: 'Kimi 未返回 access_token' }
  if (!json.refresh_token) return { status: 'error', message: 'Kimi 未返回 refresh_token，请重新授权' }
  await getKV(env).delete(DEVICE_PREFIX + state).catch(() => {})
  return { status: 'ok', refreshToken: json.refresh_token }
}

// =====================================================================
// access_token 刷新（KV 缓存）
// =====================================================================

async function refreshKimiToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string }> {
  const deviceId = randomId()
  const form = new URLSearchParams({
    client_id: KIMI_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  const res = await fetch(KIMI_TOKEN_URL, {
    method: 'POST',
    headers: mshHeaders(deviceId),
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { throw new Error(`Kimi OAuth 刷新返回非 JSON: ${text.slice(0, 200)}`) }
  if (res.status === 401 || res.status === 403) throw new Error(`Kimi refresh_token 已失效 (HTTP ${res.status})`)
  if (!res.ok || !json.access_token) throw new Error(`Kimi OAuth 刷新失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
  return { accessToken: json.access_token, expiresIn: Number(json.expires_in) || 3600, refreshToken: json.refresh_token || undefined }
}

async function getAccessToken(env: Env, refreshToken: string): Promise<string> {
  return (await resolveAccessToken(env, AT_PREFIX, refreshToken, refreshKimiToken)).accessToken
}

// =====================================================================
// 模型名归一化（与 CLIProxyAPI normalizeKimiUpstreamModel 对齐）
// =====================================================================

const KIMI_MODEL_ALIASES: Record<string, string> = {
  'kimi-k2.8': 'kimi-for-coding',
  'kimi-k2.8-code': 'kimi-for-coding',
  'kimi-k2.8-preview': 'kimi-for-coding',
  'kimi-k2.7-code': 'kimi-for-coding',
  'kimi-k2.5': 'kimi-for-coding',
  'kimi-k2-thinking': 'kimi-for-coding',
  'kimi-k2': 'kimi-for-coding',
  'k2.8': 'kimi-for-coding',
  'kimi-for-coding-highspeed': 'kimi-for-coding-highspeed',
  'kimi-k2.7-code-highspeed': 'kimi-for-coding-highspeed',
  'kimi-k2.8-highspeed': 'kimi-for-coding-highspeed',
}

export function normalizeKimiModel(model: string): string {
  const base = (model || '').trim().toLowerCase().replace(/\[1m\]$/i, '')
  return KIMI_MODEL_ALIASES[base] || base || model
}

// =====================================================================
// 对外入口（OpenAI 兼容直通）
// =====================================================================

export async function handleKimiRequest(p: OAuthCallParams): Promise<Response> {
  const tokens = (p.refreshTokens || []).filter((t) => t && t.trim())
  if (tokens.length === 0) {
    return oauthErrorResponse('该 kimi 渠道未配置凭据：请在「API Key」里每行填入一个 Kimi OAuth refresh_token（可通过设备码授权获取）', 400, 'configuration_error')
  }
  const forwardBody = { ...p.body, model: normalizeKimiModel(p.modelId) }
  let lastError = ''
  let lastStatus = 502

  for (const refreshToken of tokens) {
    try {
      const accessToken = await getAccessToken(p.env, refreshToken)
      const upstream = await fetch(`${KIMI_API_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'Accept': p.body?.stream === true ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(forwardBody),
        signal: AbortSignal.timeout(600000),
      })
      if (!upstream.ok) {
        lastStatus = upstream.status
        lastError = `HTTP ${upstream.status}: ${(await readErrorBody(upstream)).slice(0, 300)}`
        if ([401, 403, 429].includes(upstream.status) || upstream.status >= 500) continue
        return oauthErrorResponse(lastError, upstream.status, 'upstream_error')
      }
      // OpenAI 兼容：透传响应；流式用 tee 在后台提取 usage
      if (p.body?.stream === true && upstream.body) {
        const [toClient, forUsage] = upstream.body.tee()
        defer(p, scanOpenAiStreamUsage(forUsage, (usage) => recordOAuthUsage(p, usage, true, 200)))
        return new Response(toClient, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' },
        })
      }
      const rawText = await upstream.text()
      let json: any
      try { json = JSON.parse(rawText) } catch { return oauthErrorResponse(`上游返回非 JSON: ${rawText.slice(0, 200)}`, 502, 'upstream_error') }
      defer(p, recordOAuthUsage(p, {
        promptTokens: Number(json?.usage?.prompt_tokens) || 0,
        completionTokens: Number(json?.usage?.completion_tokens) || 0,
      }, true, 200))
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    } catch (err) {
      lastError = (err as Error).message || '未知错误'
      lastStatus = 502
      continue
    }
  }
  return oauthErrorResponse(`所有 Kimi 账号均失败，最后一次错误: ${lastError || '未知'}`, lastStatus, 'key_exhausted')
}

/** 后台扫描 OpenAI SSE 流，提取最后出现的 usage（不阻塞响应） */
async function scanOpenAiStreamUsage(stream: ReadableStream<Uint8Array>, onUsage: (u: { promptTokens: number; completionTokens: number }) => Promise<void>): Promise<void> {
  try {
    const text = await new Response(stream).text()
    let usage = { promptTokens: 0, completionTokens: 0 }
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload)
        if (json?.usage) {
          usage = {
            promptTokens: Number(json.usage.prompt_tokens) || 0,
            completionTokens: Number(json.usage.completion_tokens) || 0,
          }
        }
      } catch { /* ignore */ }
    }
    await onUsage(usage)
  } catch { /* ignore */ }
}

// =====================================================================
// 后台：连通性测试 / 可用模型
// =====================================================================

export async function testKimi(env: Env, refreshToken: string, modelId: string): Promise<{ success: boolean; message: string; statusCode?: number }> {
  if (!refreshToken) return { success: false, message: '未填写 refresh_token', statusCode: 0 }
  try {
    const accessToken = await getAccessToken(env, refreshToken)
    const res = await fetch(`${KIMI_API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ model: normalizeKimiModel(modelId), messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30000),
    })
    if (res.ok) return { success: true, message: '连接成功', statusCode: 200 }
    return { success: false, message: `HTTP ${res.status}: ${(await readErrorBody(res)).slice(0, 200)}`, statusCode: res.status }
  } catch (err) {
    return { success: false, message: (err as Error).message || '连接失败' }
  }
}

/** 拉取 Kimi 可用模型（尽力而为：/v1/models 可能不开放） */
export async function fetchKimiModels(env: Env, refreshToken: string): Promise<{ success: boolean; models: string[]; message?: string }> {
  try {
    const accessToken = await getAccessToken(env, refreshToken)
    const res = await fetch(`${KIMI_API_BASE}/v1/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    if (!res.ok) return { success: false, models: [], message: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    let json: any
    try { json = JSON.parse(text) } catch { return { success: false, models: [], message: '返回非 JSON' } }
    const rows: any[] = Array.isArray(json?.data) ? json.data : []
    const models = rows
      .map((m: any) => String(typeof m === 'string' ? m : m?.id || ''))
      .filter((id: string) => id)
    if (models.length === 0) return { success: false, models: [], message: '上游未返回模型列表，请手动填写（kimi-for-coding 等）' }
    return { success: true, models: [...new Set(models)] }
  } catch (err) {
    return { success: false, models: [], message: (err as Error).message || '拉取失败' }
  }
}
