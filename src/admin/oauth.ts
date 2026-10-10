/**
 * OAuth 反代渠道内置授权，以及 Vertex / Devin 的凭据校验与授权。
 */
import { Context } from 'hono'
import { ok, fail } from '../http'
import { getProvider } from '../storage'
import { buildClaudeAuthUrl, exchangeClaudeCode, fetchClaudeModels } from '../claude'
import { buildCodexAuthUrl, exchangeCodexCode } from '../codex'
import { startKimiDeviceFlow, pollKimiDeviceFlow, fetchKimiModels } from '../kimi'
import { fetchKimiWebModels } from '../kimi-web'
import { listGeminiWebModels } from '../gemini-web'
import { listMiniMaxWebModels } from '../minimax-web'
import { listLingxiModels } from '../lingxi-web'
import { startGrokDeviceFlow, pollGrokDeviceFlow } from '../grok'
import { startQwenDeviceFlow, pollQwenDeviceFlow, fetchQwenModels } from '../qwen'
import { fetchDeepSeekModels } from '../deepseek'
import { startCodebuddyDeviceFlow, pollCodebuddyDeviceFlow, fetchCodebuddyModels } from '../codebuddy'
import { startClineDeviceFlow, pollClineDeviceFlow, fetchClineModels } from '../cline'
import type { Env, ApiResponse } from '../types'

// ===== OAuth 反代渠道内置授权（claude / codex / kimi / grok） =====

const OAUTH_PROVIDERS = new Set(['claude', 'codex', 'kimi', 'grok', 'qwen', 'codebuddy', 'cline'])
// 无 OAuth 流程、凭据需从浏览器复制的渠道类型（deepseek 网页版 userToken / kimiweb 网页版 token）

/** 测试用默认模型（新增渠道尚未填写模型时） */
export const OAUTH_DEFAULT_MODELS: Record<string, string> = {
  claude: 'claude-sonnet-4-5-20250929',
  codex: 'gpt-5.5',
  kimi: 'kimi-for-coding',
  kimiweb: 'k3',
  geminiweb: 'gemini-3.7-flash',
  minimaxweb: 'MiniMax-M3',
  lingxi: 'lingxi-default',
  grok: 'grok-4.6',
  qwen: 'coder-model',
  deepseek: 'deepseek-v4-flash',
  codebuddy: 'deepseek-v4.1-flash',
  cline: 'deepseek/deepseek-v4-flash',
}

interface OAuthPollResult {
  status: 'pending' | 'ok' | 'error'
  message?: string
  refreshToken?: string
}

/** 发起授权：claude/codex 返回授权链接；kimi/grok/qwen 返回设备码信息 */
export async function handleOAuthStart(c: Context<{ Bindings: Env }>) {
  const provider = c.req.param('provider') || ''
  const body = await c.req.json<{ baseUrl?: string; region?: string }>().catch(() => ({} as { baseUrl?: string; region?: string }))
  if (!OAUTH_PROVIDERS.has(provider)) {
    return fail(c, `不支持的 OAuth 渠道类型: ${provider}`, 400)
  }
  try {
    if (provider === 'claude') {
      const { url, state } = await buildClaudeAuthUrl(c.env)
      return ok(c, { mode: 'redirect', url, state })
    }
    if (provider === 'codex') {
      const { url, state } = await buildCodexAuthUrl(c.env)
      return ok(c, { mode: 'redirect', url, state })
    }
    if (provider === 'codebuddy') {
      // 设备流：上游签发 state + 授权链接，浏览器登录后由 poll 轮询换 token
      const flow = await startCodebuddyDeviceFlow(c.env, body.baseUrl, body.region)
      return ok(c, { mode: 'redirect-poll', url: flow.authUrl, state: flow.state, realm: flow.realm })
    }
    const flow = provider === 'kimi'
      ? await startKimiDeviceFlow(c.env, body.baseUrl)
      : provider === 'qwen'
        ? await startQwenDeviceFlow(c.env)
        : provider === 'cline'
          ? await startClineDeviceFlow(c.env)
          : await startGrokDeviceFlow(c.env)
    return ok(c, { mode: 'device', state: flow.state, verification_uri: flow.verificationUri, verification_uri_complete: flow.verificationUriComplete, user_code: flow.userCode, interval: flow.interval })
  } catch (err) {
    return fail(c, (err as Error).message || '发起授权失败', 500)
  }
}

/** 完成授权（claude/codex：code + state 换 refresh_token） */
export async function handleOAuthComplete(c: Context<{ Bindings: Env }>) {
  const provider = c.req.param('provider') || ''
  const { code, state } = await c.req.json<{ code?: string; state?: string }>()
  if (!code || !state) {
    return fail(c, 'code、state 为必填项', 400)
  }
  try {
    if (provider === 'claude') {
      const { refreshToken } = await exchangeClaudeCode(c.env, code, state)
      return ok(c, { refresh_token: refreshToken })
    }
    if (provider === 'codex') {
      const { refreshToken } = await exchangeCodexCode(c.env, code, state)
      return ok(c, { refresh_token: refreshToken })
    }
    return fail(c, `${provider} 渠道使用设备码授权，请用轮询接口`, 400)
  } catch (err) {
    return fail(c, (err as Error).message || '换取 token 失败', 400)
  }
}

/** 设备码授权轮询（kimi/grok）：pending / ok(refresh_token) / error */
export async function handleOAuthPoll(c: Context<{ Bindings: Env }>) {
  const provider = c.req.param('provider') || ''
  const { state } = await c.req.json<{ state?: string }>()
  if (!state) {
    return fail(c, 'state 为必填项', 400)
  }
  try {
    let r: { status: 'pending' | 'ok' | 'error'; message?: string; refreshToken?: string } | null = null
    if (provider === 'kimi') r = await pollKimiDeviceFlow(c.env, state)
    else if (provider === 'qwen') r = await pollQwenDeviceFlow(c.env, state)
    else if (provider === 'grok') r = await pollGrokDeviceFlow(c.env, state)
    else if (provider === 'codebuddy') r = await pollCodebuddyDeviceFlow(c.env, state)
    else if (provider === 'cline') r = await pollClineDeviceFlow(c.env, state)
    if (!r) {
      return fail(c, `${provider} 渠道使用授权链接，请用 complete 接口`, 400)
    }
    // 前端按 refresh_token 读取(claude/codex 的 complete 接口也是这个命名), 这里两种都给出, 避免字段名不一致导致静默不收尾
    const data = { ...r, refresh_token: r.refreshToken } as OAuthPollResult & { refresh_token?: string }
    return ok(c, data)
  } catch (err) {
    return fail(c, (err as Error).message || '轮询失败', 500)
  }
}

/** 拉取可用模型（claude / kimi，凭据为 refresh_token） */
export async function handleOAuthModels(c: Context<{ Bindings: Env }>) {
  const provider = c.req.param('provider') || ''
  const body = await c.req.json<{ apiKey?: string; refreshToken?: string; providerId?: string; baseUrl?: string; region?: string }>().catch(() => ({} as any))
  let token = (body.refreshToken || body.apiKey || '').trim()

  // 核心优化：若前端未传 token（如已存渠道直接点击获取模型），自动读数据库中已保存的第一个有效 Key！
  if (!token) {
    const p = await getProvider(c.env, body.providerId || provider)
    token = (p?.apiKeys?.find((k) => k.enabled)?.key || p?.apiKeys?.[0]?.key || '').trim()
  }

  const { baseUrl, region } = body

  if (!token && provider !== 'qwen' && provider !== 'deepseek' && provider !== 'kimiweb'
      && provider !== 'geminiweb' && provider !== 'minimaxweb' && provider !== 'lingxi') {
    return fail(c, '未找到有效凭据，请先在渠道中添加并保存至少一个 Key，或填写 token', 400)
  }
  if (provider === 'claude') {
    const r = await fetchClaudeModels(c.env, token)
    return c.json<ApiResponse<{ models: string[]; message?: string }>>({ success: r.success, data: { models: r.models, message: r.message }, message: r.message })
  }
  if (provider === 'kimi') {
    const r = await fetchKimiModels(c.env, token, baseUrl)
    return c.json<ApiResponse<{ models: string[]; message?: string }>>({ success: r.success, data: { models: r.models, message: r.message }, message: r.message })
  }
  if (provider === 'kimiweb') {
    const r = await fetchKimiWebModels(c.env, token, baseUrl)
    return c.json<ApiResponse<{ models: string[]; message?: string }>>({ success: r.success, data: { models: r.models, message: r.message }, message: r.message })
  }
  if (provider === 'minimaxweb') {
    // MiniMax 网页版无模型目录接口，返回内置清单
    const r = listMiniMaxWebModels()
    return ok(c, { models: r.models })
  }
  if (provider === 'lingxi') {
    // 灵犀无模型目录接口，返回内置清单
    const r = listLingxiModels()
    return ok(c, { models: r.models })
  }
  if (provider === 'geminiweb') {
    // Gemini 网页版无模型目录接口，返回内置清单
    const r = listGeminiWebModels()
    return ok(c, { models: r.models })
  }
  if (provider === 'qwen') {
    // 上游无 /v1/models，返回本地维护清单
    const r = fetchQwenModels()
    return ok(c, { models: r.models })
  }
  if (provider === 'deepseek') {
    const r = fetchDeepSeekModels()
    return ok(c, { models: r.models })
  }
  if (provider === 'codebuddy') {
    const r = await fetchCodebuddyModels(c.env, token, baseUrl, region)
    return c.json<ApiResponse<{ models: string[]; message?: string }>>({ success: r.success, data: { models: r.models, message: r.message }, message: r.message })
  }
  if (provider === 'cline') {
    // 实时拉上游 /v1/models（免费 ~ 前缀通道 + 付费模型），失败回退内置清单
    const r = await fetchClineModels(c.env, token)
    return c.json<ApiResponse<{ models: string[]; message?: string }>>({ success: r.success, data: { models: r.models, message: r.message }, message: r.message })
  }
  return fail(c, `${provider} 渠道请手动填写模型列表`, 400)
}

// ===== Vertex 凭据校验 =====

/** 校验 Vertex 凭据：服务账号 JSON 或 Express API Key（后台「验证凭据」按钮用） */
export async function handleVertexVerify(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ credential?: string; model?: string; location?: string }>().catch(() => ({} as { credential?: string; model?: string; location?: string }))
  const credential = (body.credential || '').trim()
  if (!credential) return fail(c, '请先填写服务账号 JSON 或 API Key', 400)
  const { testVertex } = await import('../vertex')
  const result = await testVertex(c.env, credential, body.model?.trim() || undefined, body.location?.trim() || undefined)
  return c.json<ApiResponse<{ message: string; statusCode?: number }>>(
    result.success
      ? { success: true, data: { message: result.message, statusCode: result.statusCode } }
      : { success: false, message: result.message },
    result.success ? 200 : 400,
  )
}

// ===== Devin 授权 + 凭据校验 =====

/** Devin 授权：生成 PKCE 授权链接（无回调模式，页面直接给 code） */
export async function handleDevinOAuthStart(c: Context<{ Bindings: Env }>) {
  try {
    const { startDevinOAuth } = await import('../devin')
    const { url, state } = await startDevinOAuth(c.env)
    return ok(c, { url, state })
  } catch (err) {
    return fail(c, (err as Error).message || '生成授权链接失败', 500)
  }
}

/** Devin 授权：用 code 换 session token 并拉取用户信息 */
export async function handleDevinOAuthComplete(c: Context<{ Bindings: Env }>) {
  const { code, state } = await c.req.json<{ code?: string; state?: string }>().catch(() => ({} as { code?: string; state?: string }))
  if (!code) return fail(c, '请填写授权码 code', 400)
  try {
    const { completeDevinOAuth } = await import('../devin')
    const result = await completeDevinOAuth(c.env, code, state || '')
    return ok(c, { session_token: result.sessionToken, user_name: result.userName, user_id: result.userId, org_id: result.orgId })
  } catch (err) {
    return fail(c, (err as Error).message || '换取 token 失败', 400)
  }
}

/** 校验 Devin 凭据（GET /v3/self） */
export async function handleDevinVerify(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ credential?: string; model?: string }>().catch(() => ({} as { credential?: string; model?: string }))
  const credential = (body.credential || '').trim()
  if (!credential) return fail(c, '请先填写 session token，或点「用 Devin 账号授权」', 400)
  const { testDevin } = await import('../devin')
  const result = await testDevin(c.env, credential, body.model?.trim() || undefined)
  return c.json<ApiResponse<{ message: string }>>(
    result.success ? { success: true, data: { message: result.message } } : { success: false, message: result.message },
    result.success ? 200 : 400,
  )
}

