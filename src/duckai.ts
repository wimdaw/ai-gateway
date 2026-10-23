/**
 * Duck.ai AI Chat adapter (anonymous, no upstream API key).
 * The anti-abuse challenge is solved in the isolated QuickJS WASM runtime.
 */
import { solveDuckDuckGoChallenge, makeDuckDuckGoFeSignals } from './duckai-challenge'

const BASE_URL = 'https://duck.ai'
const STATUS_URL = `${BASE_URL}/duckchat/v1/status`
const CHAT_URL = `${BASE_URL}/duckchat/v1/chat`
const MODELS_URL = `${BASE_URL}/duckchat/v1/models`
const FE_VERSION_PATTERN = /serp_\d{8}_\d{6}_[A-Z]{2}-[0-9a-f]{20,40}/
const DEFAULT_FE_VERSION = 'serp_20260424_180649_ET-0bdc33b2a02ebf8f235def65d887787f694720a1'
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const DEFAULT_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: BASE_URL,
  Pragma: 'no-cache',
  Referer: `${BASE_URL}/`,
  'Sec-Ch-Ua': '"Chromium";v="149", "Not-A.Brand";v="24", "Google Chrome";v="149"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Linux"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': USER_AGENT,
  Cookie: '5=1; ah=wt-wt; dcs=1; dcm=3; isRecentChatOn=1',
}

export interface DuckAiModel {
  id: string
  name?: string
}

type DuckAiModelCache = { expiresAt: number; models: DuckAiModel[] }
let modelCache: DuckAiModelCache | null = null
let feVersionCache: { expiresAt: number; version: string } | null = null
let durablePublicKeyPromise: Promise<JsonWebKey> | null = null

const STATIC_FREE_MODELS: DuckAiModel[] = [
  { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
  { id: 'mistral-small-2603', name: 'Mistral Small 4' },
  { id: 'tinfoil/gpt-oss-120b', name: 'GPT-OSS 120B' },
  { id: 'tinfoil/gemma4-31b', name: 'Gemma 4 31B' },
]

const MODEL_ALIASES: Record<string, string> = {
  'gpt-4o-mini': 'gpt-5.4-mini',
  'gpt-5-mini': 'gpt-5.4-mini',
  'claude-3-haiku-20240307': 'claude-haiku-4-5',
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
  'mistral-small-2501': 'mistral-small-2603',
  'gpt-oss-120b': 'tinfoil/gpt-oss-120b',
  'gemma4-31b': 'tinfoil/gemma4-31b',
}

function responseError(message: string, status = 502): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function getFreeModels(value: unknown): DuckAiModel[] {
  if (!value || typeof value !== 'object') return []
  const raw = (value as { models?: unknown }).models
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as { id?: unknown; name?: unknown; accessTier?: unknown }
    if (typeof record.id !== 'string' || !Array.isArray(record.accessTier) || !record.accessTier.includes('free')) return []
    return [{ id: record.id, ...(typeof record.name === 'string' ? { name: record.name } : {}) }]
  })
}

export async function fetchDuckAiModels(force = false): Promise<{ models: DuckAiModel[]; status: number; message?: string }> {
  if (!force && modelCache && modelCache.expiresAt > Date.now()) {
    return { models: modelCache.models, status: 200 }
  }
  try {
    const response = await fetch(MODELS_URL, {
      headers: DEFAULT_HEADERS,
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) {
      return { models: [], status: response.status, message: `Duck.ai 模型目录返回 HTTP ${response.status}` }
    }
    const models = getFreeModels(await response.json())
    if (models.length === 0) {
      return { models: [], status: response.status, message: 'Duck.ai 未返回免费模型' }
    }
    modelCache = { models, expiresAt: Date.now() + 5 * 60 * 1000 }
    return { models, status: response.status }
  } catch (error) {
    const fallback = modelCache?.models || STATIC_FREE_MODELS
    return {
      models: fallback,
      status: 0,
      message: `Duck.ai 模型目录暂不可用：${(error as Error)?.message || '连接失败'}`,
    }
  }
}

async function getFeVersion(): Promise<string> {
  if (feVersionCache && feVersionCache.expiresAt > Date.now()) return feVersionCache.version
  try {
    const response = await fetch(`${BASE_URL}/`, {
      headers: {
        ...DEFAULT_HEADERS,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: AbortSignal.timeout(12000),
    })
    if (response.ok) {
      const html = await response.text()
      const version = html.match(FE_VERSION_PATTERN)?.[0]
      if (version) {
        feVersionCache = { version, expiresAt: Date.now() + 10 * 60 * 1000 }
        return version
      }
    }
  } catch {
    // Use the last known frontend version when the homepage is temporarily down.
  }
  return feVersionCache?.version || DEFAULT_FE_VERSION
}

async function getDurablePublicKey(): Promise<JsonWebKey> {
  if (!durablePublicKeyPromise) {
    durablePublicKeyPromise = (async () => {
      const pair = (await crypto.subtle.generateKey(
        { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['encrypt', 'decrypt'],
      )) as CryptoKeyPair
      const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
      return { ...jwk, alg: 'RSA-OAEP-256', ext: true, key_ops: ['encrypt'], use: 'enc' }
    })()
  }
  return durablePublicKeyPromise
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      if (typeof record.text === 'string') return record.text
      return ''
    }).filter(Boolean).join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

function normalizeMessages(value: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const message = entry as Record<string, unknown>
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const content = contentToText(message.content)
    return content ? [{ role, content }] : []
  })
}

function resolveModel(model: string): string {
  const clean = model.startsWith('duckai/') ? model.slice('duckai/'.length) : model
  return MODEL_ALIASES[clean] || clean
}

async function getChallenge(signal: AbortSignal): Promise<string> {
  const response = await fetch(STATUS_URL, {
    method: 'GET',
    headers: { ...DEFAULT_HEADERS, 'Cache-Control': 'no-store', 'x-vqd-accept': '1' },
    signal,
  })
  if (!response.ok) throw new Error(`Duck.ai status 返回 HTTP ${response.status}`)
  const challenge = response.headers.get('x-vqd-hash-1')
  if (!challenge) throw new Error('Duck.ai 没有返回挑战令牌')
  return challenge
}

function reasoningEffort(model: string): string {
  return model === 'claude-haiku-4-5' || model === 'tinfoil/gpt-oss-120b' ? 'low' : 'none'
}

function extractContent(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if (typeof record.content === 'string') return record.content
  return typeof record.message === 'string' ? record.message : ''
}

function parseDataLine(line: string): unknown | '[DONE]' | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).trim()
  if (!payload) return null
  if (payload === '[DONE]') return '[DONE]'
  try { return JSON.parse(payload) } catch { return null }
}

function openAiChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function streamResponse(upstream: Response, model: string): Response {
  if (!upstream.body) return responseError('Duck.ai 没有返回响应流', 502)
  const id = `chatcmpl-duckai-${crypto.randomUUID()}`
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let buffer = ''
  let sentRole = false
  let sentDone = false
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const event = parseDataLine(line)
        if (event === '[DONE]') {
          if (!sentRole) {
            controller.enqueue(encoder.encode(openAiChunk(id, model, { role: 'assistant' })))
            sentRole = true
          }
          controller.enqueue(encoder.encode(openAiChunk(id, model, {}, 'stop')))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          sentDone = true
          continue
        }
        const content = extractContent(event)
        if (!content) continue
        if (!sentRole) {
          controller.enqueue(encoder.encode(openAiChunk(id, model, { role: 'assistant' })))
          sentRole = true
        }
        controller.enqueue(encoder.encode(openAiChunk(id, model, { content })))
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      const finalEvent = parseDataLine(buffer)
      if (finalEvent !== '[DONE]') {
        const content = extractContent(finalEvent)
        if (content) {
          if (!sentRole) {
            controller.enqueue(encoder.encode(openAiChunk(id, model, { role: 'assistant' })))
            sentRole = true
          }
          controller.enqueue(encoder.encode(openAiChunk(id, model, { content })))
        }
      }
      if (!sentRole) controller.enqueue(encoder.encode(openAiChunk(id, model, { role: 'assistant' })))
      if (!sentDone) {
        controller.enqueue(encoder.encode(openAiChunk(id, model, {}, 'stop')))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      }
    },
  })
  return new Response(upstream.body.pipeThrough(transform), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' },
  })
}

async function parseNonStreamingResponse(upstream: Response, model: string): Promise<Response> {
  const text = await upstream.text()
  let content = ''
  for (const line of text.split('\n')) {
    const event = parseDataLine(line)
    if (event === '[DONE]') break
    content += extractContent(event)
  }
  return new Response(JSON.stringify({
    id: `chatcmpl-duckai-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

export async function testDuckAiModel(model: string): Promise<{ success: boolean; statusCode: number; message?: string }> {
  const result = await fetchDuckAiModels()
  if (result.status === 0) return { success: false, statusCode: 0, message: result.message }
  const resolved = resolveModel(model)
  const available = result.models.length ? result.models : STATIC_FREE_MODELS
  const success = available.some((entry) => entry.id === resolved)
  return {
    success,
    statusCode: result.status || (success ? 200 : 404),
    message: success ? undefined : result.message || `模型 ${model} 不在 Duck.ai 当前免费模型目录中`,
  }
}

export async function handleDuckAiRequest(input: { model: string; messages: unknown; stream?: boolean }): Promise<Response> {
  const messages = normalizeMessages(input.messages)
  if (messages.length === 0) return responseError('messages 不能为空', 400)

  const models = await fetchDuckAiModels()
  const available = models.models.length ? models.models : STATIC_FREE_MODELS
  const requestedModel = resolveModel(input.model)
  if (!available.some((entry) => entry.id === requestedModel)) {
    return responseError(`模型 ${input.model} 当前不可用于 Duck.ai 免费聊天`, 400)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Duck.ai 请求超过 60 秒')), 60000)
  try {
    const [challenge, feVersion, publicKey] = await Promise.all([
      getChallenge(controller.signal),
      getFeVersion(),
      getDurablePublicKey(),
    ])
    const solvedChallenge = await solveDuckDuckGoChallenge(challenge, USER_AGENT)
    const payload = {
      model: requestedModel,
      metadata: { toolChoice: { NewsSearch: false, VideosSearch: false, LocalSearch: false, WeatherForecast: false } },
      messages,
      canUseTools: true,
      reasoningEffort: reasoningEffort(requestedModel),
      canUseApproxLocation: null,
      canDelegateImageGeneration: null,
      durableStream: {
        messageId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        publicKey,
      },
    }
    const upstream = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        ...DEFAULT_HEADERS,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'x-ddg-journey-id': crypto.randomUUID().replaceAll('-', ''),
        'x-fe-signals': makeDuckDuckGoFeSignals(),
        'x-fe-version': feVersion,
        'x-vqd-hash-1': solvedChallenge,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!upstream.ok) {
      const body = (await upstream.text()).slice(0, 800)
      let detail = body
      try {
        const parsed = JSON.parse(body) as { type?: unknown; overrideCode?: unknown }
        if (parsed.type) detail = `${String(parsed.type)}${parsed.overrideCode ? ` (${String(parsed.overrideCode)})` : ''}`
      } catch { /* retain a short upstream error body */ }
      return responseError(`Duck.ai 返回 HTTP ${upstream.status}${detail ? `：${detail}` : ''}`, upstream.status)
    }
    return input.stream ? streamResponse(upstream, input.model) : await parseNonStreamingResponse(upstream, input.model)
  } catch (error) {
    const message = (error as Error)?.message || '连接失败'
    return responseError(`Duck.ai 请求失败：${message}`, controller.signal.aborted ? 504 : 502)
  } finally {
    clearTimeout(timeout)
  }
}
