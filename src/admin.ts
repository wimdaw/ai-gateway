import { Context } from 'hono'
import {
  getProviders,
  getProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  getProxyKeys,
  addProxyKey,
  updateProxyKey,
  deleteProxyKey,
  getUsageSummary,
} from './storage'
import { testModelConnection } from './proxy'
import { fetchOpenCodeModels, isOpenCodeProvider, resolveOpenCodeUrls, resolveProviderMirrorUrls, testOpenCodeModel } from './opencode'
import { PROXY_KEY_PREFIX, EXPIRY_OPTIONS, OPENCODE_DEFAULT_URL } from './config'
import type {
  Env,
  ApiResponse,
  Provider,
  Model,
  CreateProviderRequest,
  UpdateProviderRequest,
  CreateProxyKeyRequest,
  TestModelRequest,
} from './types'

// ===== 系统状态 =====

/**
 * 将 string[] 或正规对象数组统一转换为正规对象数组
 * 例: ["k1","k2"] → [{key:"k1",enabled:true},{key:"k2",enabled:true}]
 */
function normalizeArray<T>(
  items: unknown,
  mapFn: (val: string) => T
): T[] {
  if (!Array.isArray(items)) return []
  if (items.length === 0 || typeof items[0] === 'string') {
    return (items as string[]).map(mapFn)
  }
  return items as T[]
}

/** 规范化 mirrorUrls: 接受数组或换行/逗号分隔字符串, 去空去重 */
function normalizeMirrorUrls(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const parts = Array.isArray(value)
    ? value as string[]
    : String(value).split('\n').flatMap(s => s.split(',')).map(s => s.trim())
  const cleaned = [...new Set(parts.map(s => String(s).trim()).filter(Boolean))]
  return cleaned.length > 0 ? cleaned : undefined
}

/** 从模型真实 id 生成对外 alias：去掉 :free、/free 或 -free 后缀 */
export function defaultModelAlias(id: string): string {
  return id
    .replace(/:(free)$/i, '')
    .replace(/\/(free)$/i, '')
    .replace(/-(free)$/i, '')
}

/**
 * 规范化模型列表。接受 string[] 或 {id, alias?, enabled?}[]。
 * alias 未提供时自动生成（去掉 :free//free 后缀）。
 */
function normalizeModels(value: unknown): Model[] {
  if (!Array.isArray(value)) return []
  if (value.length === 0) return []
  if (typeof value[0] === 'string') {
    return (value as string[]).map((id) => ({ id, enabled: true, alias: defaultModelAlias(id) }))
  }
  return (value as Array<{ id?: string; alias?: string; enabled?: boolean }>)
    .filter((m) => m && m.id)
    .map((m) => ({
      id: m.id!,
      enabled: m.enabled !== undefined ? m.enabled : true,
      alias: m.alias !== undefined && m.alias !== '' ? m.alias : defaultModelAlias(m.id!),
    }))
}

export async function handleStatus(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const proxyKeys = await getProxyKeys(c.env)

  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0)
  const enabledModels = providers.reduce(
    (sum, p) => sum + p.models.filter((m) => m.enabled).length,
    0
  )

  return c.json<ApiResponse>({
    success: true,
    data: {
      providersCount: providers.length,
      enabledProvidersCount: providers.filter((p) => p.enabled).length,
      modelsCount: totalModels,
      enabledModelsCount: enabledModels,
      proxyKeysCount: proxyKeys.filter((k) => k.enabled).length,
      adminConfigured: !!(c.env.ADMIN_USERNAME && c.env.ADMIN_PASSWORD),
      baseUrl: new URL(c.req.url).origin,
    },
  })
}

// ===== 渠道 CRUD =====

export async function handleGetProviders(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  return c.json<ApiResponse<Provider[]>>({ success: true, data: providers })
}

export async function handleCreateProvider(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProviderRequest>()
  // opencode 未传地址时自动填充
  if (body.id === 'opencode' && !body.baseUrl) {
    body.baseUrl = OPENCODE_DEFAULT_URL
  }

  if (!body.id || !body.name || !body.baseUrl) {
    return c.json<ApiResponse>({ success: false, message: 'id、name、baseUrl 为必填项' }, 400)
  }

  const providers = await getProviders(c.env)
  if (providers.some((p) => p.id === body.id)) {
    return c.json<ApiResponse>({ success: false, message: `渠道 id "${body.id}" 已存在` }, 409)
  }

  const now = new Date().toISOString()
  const provider: Provider = {
    id: body.id,
    name: body.name,
    baseUrl: body.baseUrl.replace(/\/$/, ''),
    apiType: body.apiType || 'openai',
    type: body.type || 'openai',
apiKeys: normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true })),
    models: body.models
      ? normalizeModels(body.models)
      : [],
    mirrorUrls: normalizeMirrorUrls(body.mirrorUrls),
    voice: body.voice,
    rate: body.rate,
    volume: body.volume,
    pitch: body.pitch,
    enabled: body.enabled !== undefined ? body.enabled : true,
    createdAt: now,
    updatedAt: now,
  }

  await addProvider(c.env, provider)
  return c.json<ApiResponse<Provider>>({ success: true, data: provider }, 201)
}

export async function handleUpdateProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<UpdateProviderRequest>()

  const updates: Partial<Provider> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl.replace(/\/$/, '')
  if (body.apiType !== undefined) updates.apiType = body.apiType
  if (body.type !== undefined) updates.type = body.type
  if (body.voice !== undefined) updates.voice = body.voice
  if (body.rate !== undefined) updates.rate = body.rate
  if (body.volume !== undefined) updates.volume = body.volume
  if (body.pitch !== undefined) updates.pitch = body.pitch
  if (body.mirrorUrls !== undefined) updates.mirrorUrls = normalizeMirrorUrls(body.mirrorUrls)
if (body.apiKeys !== undefined) {
    updates.apiKeys = normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true }))
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.models !== undefined) {
    updates.models = normalizeModels(body.models)
  }

  const updated = await updateProvider(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '渠道不存在' }, 404)
  }

  // 支持重命名渠道 ID: 删除旧 ID, 用新 ID 重建(保留完整配置)
  if (body.newId && body.newId !== id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(body.newId)) {
      return c.json<ApiResponse>({ success: false, message: 'ID 只能包含字母/数字/下划线/连字符' }, 400)
    }
    const existing = await getProvider(c.env, body.newId)
    if (existing) {
      return c.json<ApiResponse>({ success: false, message: `渠道 ID "${body.newId}" 已存在` }, 400)
    }
    const renamed = { ...updated, id: body.newId, updatedAt: new Date().toISOString() }
    await deleteProvider(c.env, id)
    await addProvider(c.env, renamed)
    return c.json<ApiResponse<Provider>>({ success: true, data: renamed, message: '渠道 ID 已更新' })
  }

  return c.json<ApiResponse<Provider>>({ success: true, data: updated })
}

export async function handleDeleteProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProvider(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '渠道不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '渠道已删除' })
}

export async function handleTestModel(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const { modelId } = await c.req.json<TestModelRequest>()

  if (!modelId) {
    return c.json<ApiResponse>({ success: false, message: 'modelId 为必填项' }, 400)
  }

  const provider = await getProvider(c.env, id)
  if (!provider) {
    return c.json<ApiResponse>({ success: false, message: '渠道不存在' }, 404)
  }

  const modelConfig = provider.models.find((m) => m.id === modelId)
  if (!modelConfig) {
    return c.json<ApiResponse>({ success: false, message: `模型 "${modelId}" 不存在于渠道 "${provider.name}"` }, 404)
  }

  const enabledKeys = provider.apiKeys.filter(k => k.enabled)
  const result = isOpenCodeProvider(provider.id)
    ? await testOpenCodeModel(provider.baseUrl, enabledKeys, modelId, resolveProviderMirrorUrls(c.env, provider))
    : await testModelConnection(provider.baseUrl, enabledKeys[0]?.key || '', modelId, provider.apiType)

  return c.json<ApiResponse>({
    success: true,
    data: result,
  })
}

// ===== Key / 模型连通性测试（通过服务端代理，避免 CORS） =====

function buildAuthHeaders(apiKey: string, apiType?: string): Record<string, string> {
  if (apiType === 'anthropic') {
    const h: Record<string, string> = { 'anthropic-version': '2023-06-01' }
    if (apiKey) h['x-api-key'] = apiKey
    return h
  }
  if (!apiKey) return {}
  return { 'Authorization': `Bearer ${apiKey}` }
}

export async function handleTestKeyNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, providerId, mirrorUrls, freeOnly } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    providerId?: string
    mirrorUrls?: string[] | string
    freeOnly?: boolean
  }>()
  if (!url) {
    return c.json<ApiResponse>({ success: false, message: 'url 为必填项' }, 400)
  }

  if (providerId && isOpenCodeProvider(providerId)) {
    // 没填 key 时检查是否配了镜像，避免迷惑性报错
    if (!apiKey) {
      const mirrors = normalizeMirrorUrls(mirrorUrls) ?? resolveOpenCodeUrls(c.env)
      if (mirrors.length === 0) {
        return c.json<ApiResponse>({
          success: true,
          data: { success: false, statusCode: 0, message: '请先填写 API Key 或配置镜像地址' },
        })
      }
    }
    const result = await fetchOpenCodeModels(url, [{ key: apiKey, enabled: true }], normalizeMirrorUrls(mirrorUrls) ?? resolveOpenCodeUrls(c.env))
    return c.json<ApiResponse>({
      success: true,
      data: {
        success: result.success,
        statusCode: result.statusCode || 0,
        message: result.message,
        data: freeOnly ? filterFreeModels(result.data) : result.data,
      },
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

    return c.json<ApiResponse>({
      success: true,
      data: { success: response.ok, statusCode: response.status, data: freeOnly ? filterFreeModels(data) : data },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

/**
 * 从 /models 响应中过滤出免费模型。
 * 兼容 OpenAI 兼容格式（data: [{ id, ... }]）与 OpenRouter/kilo 格式（pricing.prompt === '0' 或 id 含 :free / /free）。
 */
function filterFreeModels(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  const arr = (data as { data?: unknown }).data
  if (!Array.isArray(arr)) return data

  const isFree = (m: Record<string, unknown>): boolean => {
    const id = String(m.id || '').toLowerCase()
    // 命名约定: openrouter 风格 :free 后缀, kilo 风格 /free 后缀或 id 含 free
    if (id.endsWith(':free') || id.endsWith('/free') || id.includes('free')) return true
    // pricing 约定: prompt === 0
    const pricing = m.pricing as Record<string, unknown> | undefined
    if (pricing) {
      const prompt = pricing.prompt
      if (prompt === 0 || prompt === '0' || prompt === '0.000000000000' || Number(prompt) === 0) return true
    }
    return false
  }

  return { ...data, data: arr.filter((m) => m && typeof m === 'object' && isFree(m as Record<string, unknown>)) }
}

export async function handleTestModelNew(c: Context<{ Bindings: Env }>) {
  const { url, apiKey, apiType, model, providerId, mirrorUrls } = await c.req.json<{
    url: string
    apiKey: string
    apiType?: string
    model: string
    providerId?: string
    mirrorUrls?: string[] | string
  }>()
  if (!url || !model) {
    return c.json<ApiResponse>({ success: false, message: 'url、model 为必填项' }, 400)
  }

  if (providerId && isOpenCodeProvider(providerId)) {
    const apiKeys = apiKey ? [{ key: apiKey, enabled: true }] : []
    const result = await testOpenCodeModel(url, apiKeys, model, normalizeMirrorUrls(mirrorUrls) ?? resolveOpenCodeUrls(c.env))
    return c.json<ApiResponse>({
      success: true,
      data: { success: result.success, statusCode: result.statusCode || 0, message: result.message },
    })
  }

  const cleanBase = url.replace(/\/$/, '')
  const endpoint = apiType === 'anthropic' ? 'messages' : 'chat/completions'

  try {
    const response = await fetch(`${cleanBase}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(apiKey, apiType) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000),
    })

    return c.json<ApiResponse>({
      success: true,
      data: { success: response.ok, statusCode: response.status },
    })
  } catch (err) {
    return c.json<ApiResponse>({
      success: true,
      data: { success: false, statusCode: 0, message: (err as Error).message || '连接失败' },
    })
  }
}

// ===== 令牌管理 =====

export async function handleGetProxyKeys(c: Context<{ Bindings: Env }>) {
  const keys = await getProxyKeys(c.env)
  const maskedKeys = keys.map((k) => ({
    ...k,
    key: k.key.length > 12
      ? k.key.substring(0, 8) + '****' + k.key.substring(k.key.length - 4)
      : k.key,
  }))
  return c.json<ApiResponse>({ success: true, data: maskedKeys })
}

export async function handleCreateProxyKey(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProxyKeyRequest>()
  const id = crypto.randomUUID()
  const randomPart = crypto.randomUUID().replace(/-/g, '')
  const key = `${PROXY_KEY_PREFIX}${randomPart}`

  // 计算过期时间
  let expiresAt: string | null = null
  if (body.expiresIn && body.expiresIn !== 'forever') {
    const ttl = EXPIRY_OPTIONS[body.expiresIn]
    if (ttl) {
      expiresAt = new Date(Date.now() + ttl * 1000).toISOString()
    }
  }

  const proxyKey = {
    id,
    key,
    name: body.name || `Key-${new Date().toLocaleDateString()}`,
    enabled: true,
    createdAt: new Date().toISOString(),
    expiresAt,
  }

  await addProxyKey(c.env, proxyKey)
  return c.json<ApiResponse>({
    success: true,
    data: proxyKey,
    message: '请立即保存此 Key，关闭后将不再显示',
  }, 201)
}

export async function handleDeleteProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const deleted = await deleteProxyKey(c.env, id)
  if (!deleted) {
    return c.json<ApiResponse>({ success: false, message: '令牌不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, message: '令牌已删除' })
}

export async function handleUpdateProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400)
  const body = await c.req.json<{ enabled?: boolean; regenerate?: boolean }>()
  const updates: Partial<import('./types').ProxyKey> = {}
  if (body.enabled !== undefined) updates.enabled = body.enabled
  // 重新生成: 生成新的 key 值(旧 key 立即失效)
  if (body.regenerate) {
    const randomPart = crypto.randomUUID().replace(/-/g, '')
    updates.key = `${PROXY_KEY_PREFIX}${randomPart}`
    updates.createdAt = new Date().toISOString()
  }
  const updated = await updateProxyKey(c.env, id, updates)
  if (!updated) {
    return c.json<ApiResponse>({ success: false, message: '令牌不存在' }, 404)
  }
  return c.json<ApiResponse>({ success: true, data: updated })
}

// ===== Token 用量统计 =====

export async function handleTtsPreview(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ provider?: string; voice?: string; text?: string }>().catch(() => ({} as { provider?: string; voice?: string; text?: string }))
  const providerId = body.provider || 'tts'
  const provider = await getProvider(c.env, providerId)
  if (!provider) return c.json<ApiResponse>({ success: false, message: `渠道 "${providerId}" 不存在` }, 404)
  if ((provider.type || 'openai') !== 'azure-tts') {
    return c.json<ApiResponse>({ success: false, message: `渠道 "${providerId}" 不是 azure-tts 类型` }, 400)
  }
  const { synthesizeAzureTts } = await import('./azure-tts')
  const voice = body.voice || provider.voice || 'zh-CN-XiaoxiaoNeural'
  // 试听文本按音色语言自动匹配, 避免中文音色念英文
  const previewText = (v: string): string => {
    if (v.startsWith('zh-')) return '你好,这是语音试听,欢迎使用。'
    if (v.startsWith('ja-')) return 'こんにちは、これは音声プレビューです。'
    if (v.startsWith('ko-')) return '안녕하세요, 음성 미리보기입니다.'
    if (v.startsWith('fr-')) return 'Bonjour, ceci est un aperçu vocal.'
    if (v.startsWith('de-')) return 'Hallo, dies ist eine Sprachvorschau.'
    if (v.startsWith('ru-')) return 'Здравствуйте, это голосовой предпросмотр.'
    if (v.startsWith('es-')) return 'Hola, esta es una vista previa de voz.'
    if (v.startsWith('it-')) return 'Ciao, questa è un\'anteprima vocale.'
    if (v.startsWith('pt-')) return 'Olá, esta é uma prévia de voz.'
    if (v.startsWith('ar-')) return 'مرحباً، هذه معاينة صوتية.'
    if (v.startsWith('hi-')) return 'नमस्ते, यह एक आवाज़ पूर्वावलोकन है।'
    if (v.startsWith('id-')) return 'Halo, ini adalah pratinjau suara.'
    if (v.startsWith('th-')) return 'สวัสดี นี่คือตัวอย่างเสียง'
    if (v.startsWith('vi-')) return 'Xin chào, đây là bản xem trước giọng nói.'
    if (v.startsWith('tr-')) return 'Merhaba, bu bir ses önizlemesidir.'
    if (v.startsWith('pl-')) return 'Cześć, to jest podgląd głosu.'
    if (v.startsWith('nl-')) return 'Hallo, dit is een spraakvoorbeeld.'
    if (v.startsWith('sv-')) return 'Hej, detta är en röstförhandsvisning.'
    if (v.startsWith('uk-')) return 'Привіт, це голосовий попередній перегляд.'
    if (v.startsWith('cs-')) return 'Ahoj, toto je hlasová ukázka.'
    if (v.startsWith('da-')) return 'Hej, dette er en stemmeprøve.'
    if (v.startsWith('fi-')) return 'Hei, tämä on ääniesikatselu.'
    if (v.startsWith('el-')) return 'Γεια σας, αυτή είναι μια προεπισκόπηση φωνής.'
    if (v.startsWith('he-')) return 'שלום, זוהי תצוגה מקדימה של קול.'
    if (v.startsWith('nb-')) return 'Hei, dette er en taleprøve.'
    if (v.startsWith('en-')) return 'Hello, this is a voice preview.'
    return '你好,这是语音试听,欢迎使用。'
  }
  const text = (body.text || previewText(voice)).slice(0, 100)
  try {
    const { audio, usedVoice } = await synthesizeAzureTts(text, {
      voice,
      rate: provider.rate || '+0%',
      volume: provider.volume || '+0%',
      pitch: provider.pitch || '+0Hz',
    })
    return new Response(audio, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audio.byteLength),
        'X-Azure-TTS-Voice': usedVoice,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json<ApiResponse>({ success: false, message: `试听失败: ${message}` }, 502)
  }
}

export async function handleGetUsage(c: Context<{ Bindings: Env }>) {
  const q = c.req.query('days')
  // 默认显示今天(1天)
  const days = Math.min(Math.max(parseInt(q || '1') || 1, 1), 30)
  const summary = await getUsageSummary(c.env, days)
  return c.json<ApiResponse>({ success: true, data: summary })
}
