/**
 * 渠道连通性测试：单模型测试、Key/模型列表探测、OAuth 渠道凭据测试。
 */
import { Context } from 'hono'
import { ok, fail } from '../http'
import { getProvider } from '../storage'
import { testModelConnectionRotating } from '../proxy'
import { testAntigravity, testAntigravityRotating } from '../antigravity'
import { testClaude } from '../claude'
import { testCodex } from '../codex'
import { testKimi } from '../kimi'
import { testKimiWeb } from '../kimi-web'
import { testGeminiWeb } from '../gemini-web'
import { testMiniMaxWeb } from '../minimax-web'
import { testLingxi } from '../lingxi-web'
import { testGrok } from '../grok'
import { testQwen } from '../qwen'
import { testDeepSeek } from '../deepseek'
import { testCodebuddy } from '../codebuddy'
import { testCline } from '../cline'
import { fetchZaiModels } from '../zai'
import { fetchOpenCodeModels, isOpenCodeProvider, resolveOpenCodeUrls, resolveProviderMirrorUrls, testOpenCodeModel } from '../opencode'
import type { Env, TestModelRequest } from '../types'
import { OAUTH_DEFAULT_MODELS } from './oauth'
import { buildAuthHeaders, filterFreeModels, normalizeMirrorUrls, normalizeModelsResponse } from './common'

export async function handleTestModel(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return fail(c, '缺少 id 参数', 400)
  const { modelId } = await c.req.json<TestModelRequest>()

  if (!modelId) {
    return fail(c, 'modelId 为必填项', 400)
  }

  const provider = await getProvider(c.env, id)
  if (!provider) {
    return fail(c, '渠道不存在', 404)
  }

  const modelConfig = provider.models.find((m) => m.id === modelId)
  if (!modelConfig) {
    return fail(c, `模型 "${modelId}" 不存在于渠道 "${provider.name}"`, 404)
  }

  const enabledKeys = provider.apiKeys.filter(k => k.enabled)
  // 多 key 轮询测试：逐个 key 尝试，遇 429/401/403/5xx 自动切换下一个 key，避免误报限流
  const ptype = provider.type || 'openai'
  const result = isOpenCodeProvider(provider.id)
    ? await testOpenCodeModel(provider.baseUrl, enabledKeys, modelId, resolveProviderMirrorUrls(c.env, provider))
    : ptype === 'antigravity'
      ? await testAntigravityRotating(c.env, enabledKeys.map(k => k.key), modelId, provider.project)
      : ['claude', 'codex', 'kimi', 'kimiweb', 'geminiweb', 'minimaxweb', 'lingxi', 'grok', 'qwen', 'deepseek', 'codebuddy', 'cline'].includes(ptype)
        ? await testOAuthProviderRotating(c.env, ptype, enabledKeys.map(k => k.key), modelId, provider.baseUrl, provider.id, provider.region)
        : await testModelConnectionRotating(provider.baseUrl, enabledKeys.map(k => k.key), modelId, provider.apiType)

  return ok(c, result)
}

// ===== Key / 模型连通性测试（通过服务端代理，避免 CORS） =====

export async function handleTestKeyNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, providerType, providerId, mirrorUrls, freeOnly, model, project } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    providerType?: string
    providerId?: string
    mirrorUrls?: string[] | string
    freeOnly?: boolean
    model?: string
    project?: string
  }>()

  // antigravity: apiKey 即 refresh_token
  if (providerType === 'antigravity') {
    const r = await testAntigravity(c.env, apiKey, model || 'gemini-3.5-flash', project)
    return ok(c, { success: r.success, statusCode: r.statusCode || 0, message: r.message })
  }

  // OAuth 反代渠道: apiKey 即 refresh_token
  if (providerType && ['claude', 'codex', 'kimi', 'kimiweb', 'geminiweb', 'minimaxweb', 'lingxi', 'grok', 'qwen', 'deepseek', 'codebuddy', 'cline'].includes(providerType)) {
    const r = await testOAuthProvider(c.env, providerType, apiKey, model || OAUTH_DEFAULT_MODELS[providerType], url, providerId)
    return ok(c, { success: r.success, statusCode: r.statusCode || 0, message: r.message })
  }

  // Z.AI: 上游 /models 需有效 Key，这里回内置清单（供「获取模型」按钮使用）
  if (providerType === 'zai') {
    const models = fetchZaiModels().models
    const list = (freeOnly ? models.filter((m) => /flash|air/i.test(m)) : models).map((id) => ({ id }))
    return ok(c, { success: true, statusCode: 200, data: { object: 'list', data: list } })
  }

  if (!url) {
    return fail(c, 'url 为必填项', 400)
  }

  if (providerId && isOpenCodeProvider(providerId)) {
    // 没填 key 时检查是否配了镜像，避免迷惑性报错
    if (!apiKey) {
      const mirrors = normalizeMirrorUrls(mirrorUrls) ?? resolveOpenCodeUrls(c.env)
      if (mirrors.length === 0) {
        return ok(c, { success: false, statusCode: 0, message: '请先填写 API Key 或配置镜像地址' })
      }
    }
    const result = await fetchOpenCodeModels(url, [{ key: apiKey, enabled: true }], normalizeMirrorUrls(mirrorUrls) ?? resolveOpenCodeUrls(c.env))
    return ok(c, {
        success: result.success,
        statusCode: result.statusCode || 0,
        message: result.message,
        data: freeOnly ? filterFreeModels(result.data) : result.data,
      })
  }

  const cleanBase = url.replace(/\/$/, '')
  try {
    const response = await fetch(`${cleanBase}/models`, {
      method: 'GET', headers: buildAuthHeaders(apiKey, apiType), signal: AbortSignal.timeout(15000),
    })

    let data: unknown = null
    if (response.ok) {
      try { data = await response.json() } catch { /* ignore */ }
    }

    const normalized = normalizeModelsResponse(data)

    return ok(c, { success: response.ok, statusCode: response.status, data: freeOnly ? filterFreeModels(normalized) : normalized })
  } catch (err) {
    return ok(c, { success: false, statusCode: 0, message: (err as Error).message || '连接失败' })
  }
}

export async function handleTestModelNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, providerType, model, providerId, mirrorUrls, project } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    providerType?: string
    model: string
    providerId?: string
    mirrorUrls?: string[] | string
    project?: string
  }>()

  // antigravity: apiKey 即 refresh_token
  if (providerType === 'antigravity') {
    const r = await testAntigravity(c.env, apiKey, model, project)
    return ok(c, { success: r.success, statusCode: r.statusCode || 0, message: r.message })
  }

  // OAuth 反代渠道: apiKey 即 refresh_token
  if (providerType && ['claude', 'codex', 'kimi', 'kimiweb', 'geminiweb', 'minimaxweb', 'lingxi', 'grok', 'qwen', 'deepseek', 'codebuddy', 'cline'].includes(providerType)) {
    const r = await testOAuthProvider(c.env, providerType, apiKey, model, url, providerId)
    return ok(c, { success: r.success, statusCode: r.statusCode || 0, message: r.message })
  }

  if (!url || !model) {
    return fail(c, 'url、model 为必填项', 400)
  }

  if (providerId && isOpenCodeProvider(providerId)) {
    const apiKeys = apiKey ? [{ key: apiKey, enabled: true }] : []
    const result = await testOpenCodeModel(url, apiKeys, model, normalizeMirrorUrls(mirrorUrls) ?? resolveOpenCodeUrls(c.env))
    return ok(c, { success: result.success, statusCode: result.statusCode || 0, message: result.message })
  }

  const cleanBase = url.replace(/\/$/, '')
  const endpoint = apiType === 'anthropic' ? 'messages' : 'chat/completions'

  try {
    let response = await fetch(`${cleanBase}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey, apiType) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: true }),
      signal: AbortSignal.timeout(15000),
    })

    // 如果流式测试未成功，尝试不带 stream 的非流式测试（兼容部分要求/拒绝 stream 的上游）
    if (!response.ok) {
      const altResponse = await fetch(`${cleanBase}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey, apiType) },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(15000),
      }).catch(() => null)
      if (altResponse && altResponse.ok) {
        response = altResponse
      }
    }

    let message: string | undefined
    if (!response.ok) {
      try {
        const errJson = await response.json() as any
        message = errJson.detail || errJson.error?.message || errJson.message
      } catch {
        try { message = await response.text() } catch { /* ignore */ }
      }
    }

    return ok(c, { success: response.ok, statusCode: response.status, message })
  } catch (err) {
    return ok(c, { success: false, statusCode: 0, message: (err as Error).message || '连接失败' })
  }
}

/** 单凭据连通性测试分发（OAuth 渠道） */
async function testOAuthProvider(
  env: Env,
  provider: string,
  refreshToken: string,
  modelId: string,
  baseUrl?: string,
  providerId?: string,
  region?: string,
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  if (provider === 'claude') return testClaude(env, refreshToken, modelId)
  if (provider === 'codex') return testCodex(env, refreshToken, modelId, providerId)
  if (provider === 'kimi') return testKimi(env, refreshToken, modelId, baseUrl)
  if (provider === 'kimiweb') return testKimiWeb(env, refreshToken, modelId, baseUrl)
  if (provider === 'geminiweb') return testGeminiWeb(env, refreshToken, modelId)
  if (provider === 'minimaxweb') return testMiniMaxWeb(env, refreshToken, modelId, providerId)
  if (provider === 'lingxi') return testLingxi(env, refreshToken, providerId)
  if (provider === 'grok') return testGrok(env, refreshToken, modelId)
  if (provider === 'qwen') return testQwen(env, refreshToken, modelId)
  if (provider === 'deepseek') return testDeepSeek(env, refreshToken, modelId)
  if (provider === 'codebuddy') return testCodebuddy(env, refreshToken, modelId, baseUrl, region)
  if (provider === 'cline') return testCline(env, refreshToken, modelId)
  return { success: false, message: `未知 OAuth 渠道类型: ${provider}` }
}

/** 多凭据轮换测试（OAuth 渠道），与 testModelConnectionRotating 语义一致 */
async function testOAuthProviderRotating(
  env: Env,
  provider: string,
  refreshTokens: string[],
  modelId: string,
  baseUrl?: string,
  providerId?: string,
  region?: string,
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const list = (refreshTokens || []).filter((t) => t && t.trim())
  if (list.length === 0) {
    // codex 走中继时凭据在对端，渠道可不配 refresh_token，交给 testCodex 判定
    if (provider === 'codex') return testOAuthProvider(env, provider, '', modelId, baseUrl, providerId, region)
    return { success: false, message: '该渠道未配置任何 refresh_token', statusCode: 0 }
  }
  let last: { success: boolean; message: string; statusCode?: number } = { success: false, message: '连接失败', statusCode: 0 }
  for (let i = 0; i < list.length; i++) {
    const r = await testOAuthProvider(env, provider, list[i].trim(), modelId, baseUrl, providerId, region)
    if (r.success) {
      return { ...r, message: list.length > 1 ? `${r.message} (账号 #${i + 1}/${list.length})` : r.message }
    }
    last = r
    const st = r.statusCode || 0
    if (st === 429 || st === 401 || st === 403 || st >= 500) continue
    break
  }
  return last
}

