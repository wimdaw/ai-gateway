
// EdgeOne 兼容: AbortSignal.timeout 在部分 runtime 不可用
function timeoutMs(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}
import { Context } from './hono-compat.mjs'
import { getProvider, getProviders } from './storage'
import { KV_KEYS, KEY_HEALTH_COOLDOWN_MS, KEY_HEALTH_MAX_FAILURES } from './config'
import type { Env, ProxyRequestBody } from './types'
import { isOpenCodeProvider, isKiloProvider, proxyOpenCodeRequest, resolveOpenCodeUrls } from './opencode'

// ===== Key 健康状态类型和辅助函数 =====

interface KeyHealth {
  failures: number
  lastFailed: boolean
  demotedAt?: number  // 首次达到降权阈值的时间戳 (Date.now())
}
type HealthMap = Record<string, KeyHealth>

const HEALTH_KEY = (providerId: string) => KV_KEYS.KEY_HEALTH_PREFIX + providerId

async function readHealth(env: Env, providerId: string): Promise<HealthMap> {
  const raw = await env.KV.get(HEALTH_KEY(providerId))
  return raw ? JSON.parse(raw) : {}
}

async function writeHealth(env: Env, providerId: string, health: HealthMap): Promise<void> {
  // 只保存有失败记录的 key，避免 KV 膨胀
  const filtered: HealthMap = {}
  for (const [k, v] of Object.entries(health)) {
    if (v.failures > 0) filtered[k] = v
  }
  if (Object.keys(filtered).length > 0) {
    await env.KV.put(HEALTH_KEY(providerId), JSON.stringify(filtered))
  } else {
    // 全部健康，删除 KV 条目
    await env.KV.delete(HEALTH_KEY(providerId)).catch(() => {})
  }
}

/** 解析模型 ID，如 "deepseek/deepseek-chat" → { providerId, modelId } */
function parseModelId(model: string): { providerId: string; modelId: string } | null {
  const slashIndex = model.indexOf('/')
  if (slashIndex === -1) return null
  return {
    providerId: model.substring(0, slashIndex),
    modelId: model.substring(slashIndex + 1),
  }
}

/** 测试模型连接，发送最小请求验证 */
export async function testModelConnection(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  apiType?: 'openai' | 'anthropic'
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  try {
    const cleanBase = baseUrl.replace(/\/$/, '')
    const endpoint = apiType === 'anthropic' ? 'messages' : 'chat/completions'
    const url = `${cleanBase}/${endpoint}`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (apiType === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: timeoutMs(15000),
    })

    if (response.ok) {
      return { success: true, message: '连接成功', statusCode: response.status }
    }

    // fetch 响应体只能消费一次: 先读文本, 再尝试解析 JSON; 若先 json() 失败再 text() 会抛
    // "Body has already been used" 从而掩盖真实状态码(如 429)
    const rawBody = await response.text()
    let errorBody = rawBody
    try {
      const errorData = JSON.parse(rawBody) as { error?: { message?: string }; message?: string }
      errorBody = errorData?.error?.message || errorData?.message || rawBody
    } catch {
      // 非 JSON 响应, 直接使用原始文本
    }

    return {
      success: false,
      message: `HTTP ${response.status}: ${errorBody.substring(0, 200)}`,
      statusCode: response.status,
    }
  } catch (err) {
    const error = err as Error
    return {
      success: false,
      message: `连接失败: ${error.message?.substring(0, 200) || '未知错误'}`,
    }
  }
}

/**
 * 多 Key 轮询测试模型连接。
 * 依次尝试每个已启用 key；遇到限流(429)、鉴权失败(401/403) 或上游 5xx 时自动切换到下一个 key；
 * 命中可用 key 立即返回成功。用于后台"测试模型"，避免单个 key 被限流时误报整个渠道不可用。
 */
export async function testModelConnectionRotating(
  baseUrl: string,
  keys: string[],
  modelId: string,
  apiType?: 'openai' | 'anthropic'
): Promise<{ success: boolean; message: string; statusCode?: number; keyIndex?: number }> {
  const list = (keys || []).filter((k) => k && k.trim())
  if (list.length === 0) {
    return { success: false, message: '该渠道未启用任何 API Key', statusCode: 0 }
  }

  let last: { success: boolean; message: string; statusCode?: number } | null = null
  for (let i = 0; i < list.length; i++) {
    const r = await testModelConnection(baseUrl, list[i], modelId, apiType)
    if (r.success) {
      return {
        ...r,
        keyIndex: i,
        message: list.length > 1 ? `${r.message} (key #${i + 1}/${list.length})` : r.message,
      }
    }
    last = r
    const st = r.statusCode || 0
    if (st === 429 || st === 401 || st === 403 || st >= 500) continue
    break
  }
  return last || { success: false, message: '连接失败', statusCode: 0 }
}

/** 处理 /v1/chat/completions 等 API 转发 */
export async function handleProxy(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<ProxyRequestBody>()
    const model = body.model

    if (!model) {
      return c.json({ error: { message: '缺少 model 参数', type: 'invalid_request_error' } }, 400)
    }

    const parsed = parseModelId(model)
    if (!parsed) {
      return c.json({
        error: {
          message: `模型格式错误 "${model}"，请使用 渠道ID/模型ID 格式`,
          type: 'invalid_request_error',
        },
      }, 400)
    }

    const { providerId, modelId } = parsed
    const provider = await getProvider(c.env, providerId)

    if (!provider) {
      return c.json({
        error: { message: `渠道 "${providerId}" 不存在`, type: 'invalid_request_error' },
      }, 404)
    }

    if (!provider.enabled) {
      return c.json({
        error: { message: `渠道 "${provider.name}" 已禁用`, type: 'provider_disabled' },
      }, 403)
    }

    const modelConfig = provider.models.find((m) => m.id === modelId)
    if (!modelConfig) {
      return c.json({
        error: { message: `模型 "${modelId}" 未在渠道 "${provider.name}" 中配置`, type: 'invalid_request_error' },
      }, 404)
    }
    if (!modelConfig.enabled) {
      return c.json({
        error: { message: `模型 "${modelId}" 已禁用`, type: 'model_disabled' },
      }, 403)
    }

    const enabledKeys = provider.apiKeys.filter(k => k.enabled)
    const forwardBody = { ...body, model: modelId }
    const url = new URL(c.req.url)
    const subPath = url.pathname.replace(/^\/v1\//, '') || 'chat/completions'

    if (isOpenCodeProvider(providerId)) {
      const response = await proxyOpenCodeRequest({
        baseUrl: provider.baseUrl,
        apiKeys: enabledKeys,
        method: c.req.method,
        subPath,
        search: url.search,
        body: JSON.stringify(forwardBody),
        mirrorUrls: resolveOpenCodeUrls(c.env, provider),
      })
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }

    // Kilo 免费网关: 无 key 时用空 Bearer 直连官方
    if (isKiloProvider(providerId)) {
      const cleanBase = provider.baseUrl.replace(/\/$/, '')
      const forwardUrl = `${cleanBase}/${subPath}${url.search}`
      const upstreamKey = enabledKeys.length > 0 ? enabledKeys[0].key : ''
      const response = await fetch(forwardUrl, {
        method: c.req.method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${upstreamKey}`,
        },
        body: JSON.stringify(forwardBody),
        signal: timeoutMs(60000),
      })
      const responseHeaders: Record<string, string> = {
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'no-store',
      }
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    }

    // 免 key 渠道支持: 无 key 时用空 Bearer 直连 (opencode/kilo 已在上方分支处理,
    // 这里覆盖用户自定义添加的任意免 key 渠道)
    const keysToUse = (enabledKeys.length > 0 ? enabledKeys : [{ key: '', enabled: true }]) as typeof enabledKeys

    const cleanBase = provider.baseUrl.replace(/\/$/, '')
    const forwardUrl = `${cleanBase}/${subPath}${url.search}`

    // 按健康状态排序 key：健康→洗牌，不健康→末尾，冷却到期→试用，连续失败3次→降权排除
    const healthData = await readHealth(c.env, providerId)
    const healthy: number[] = []
    const unhealthy: number[] = []
    const probation: number[] = []
    const demoted: number[] = []

    if (keysToUse.length === 1) {
      // 只有一个 key (含免 key 的空 key)，跳过健康检查，直接使用
      healthy.push(0)
    } else {
      for (let i = 0; i < keysToUse.length; i++) {
        const h = healthData[keysToUse[i].key]
        if (h && h.failures >= KEY_HEALTH_MAX_FAILURES) {
          // 兼容旧数据：无 demotedAt 视为现在刚降权，统一走冷却逻辑
          if (!h.demotedAt) {
            h.demotedAt = Date.now()
          }
          if (Date.now() - h.demotedAt >= KEY_HEALTH_COOLDOWN_MS) {
            probation.push(i)  // 冷却到期，进入试用组
          } else {
            demoted.push(i)    // 仍在冷却，继续保持降权
          }
        } else if (h && h.lastFailed) {
          unhealthy.push(i)
        } else {
          healthy.push(i)
        }
      }
    }

    // Fisher-Yates 洗牌（仅健康 key）
    for (let i = healthy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [healthy[i], healthy[j]] = [healthy[j], healthy[i]]
    }

    const keyOrder = [...healthy, ...unhealthy, ...probation]

    // 所有 key 都在冷却中时，降级尝试 demoted key（修复旧数据缺失 demotedAt 的死循环）
    if (keyOrder.length === 0 && demoted.length > 0) {
      keyOrder.push(...demoted)
      console.log(`[proxy] ${providerId}: all keys demoted, falling back to ${demoted.length} key(s)`)
    }

    if (demoted.length > 0 || probation.length > 0) {
      console.log(`[proxy] ${providerId}: ${demoted.length} key(s) demoted, ${probation.length} key(s) on probation (cooldown expired)`)
    }

    let lastError: Response | null = null
    let healthUpdated = false

    for (const keyIndex of keyOrder) {
      const apiKey = keysToUse[keyIndex].key
      try {
        const forwardHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
        }
        if (provider.apiType === 'anthropic') {
          forwardHeaders['x-api-key'] = apiKey
          forwardHeaders['anthropic-version'] = '2023-06-01'
        } else {
          forwardHeaders['Authorization'] = `Bearer ${apiKey}`
        }

        const response = await fetch(forwardUrl, {
          method: c.req.method,
          headers: forwardHeaders,
          body: JSON.stringify(forwardBody),
          signal: timeoutMs(60000),
        })

        if (response.ok) {
          // 成功：重置健康状态
          if (healthData[apiKey]?.failures > 0) {
            delete healthData[apiKey]
            healthUpdated = true
          }
          if (healthUpdated) await writeHealth(c.env, providerId, healthData)

          const responseHeaders: Record<string, string> = {
            'Content-Type': response.headers.get('Content-Type') || 'application/json',
            'Cache-Control': 'no-store',
          }
          return new Response(response.body, {
            status: response.status,
            headers: responseHeaders,
          })
        }

        // 429 限流：跳过当前 key，不标记失败
        if (response.status === 429) {
          lastError = response
          continue
        }

        // 401/403/5xx 尝试下一个 key（标记失败）
        if (response.status === 401 || response.status === 403 || response.status >= 500) {
          const h = healthData[apiKey] || { failures: 0, lastFailed: false }
          h.failures++
          h.lastFailed = true
          if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
            h.demotedAt = Date.now()  // 达到降权阈值或试用失败，重置冷却计时
          }
          healthData[apiKey] = h
          healthUpdated = true
          lastError = response
          continue
        }

        // 其他错误（400/404 等）直接返回
        const errorData = await response.json().catch(async () => ({ error: { message: await response.text() } }))
        return c.json(errorData, response.status as Parameters<typeof c.json>[1])
      } catch (err) {
        const error = err as Error
        // 网络错误也标记为失败
        const h = healthData[apiKey] || { failures: 0, lastFailed: false }
        h.failures++
        h.lastFailed = true
        if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
          h.demotedAt = Date.now()  // 达到降权阈值或试用失败，重置冷却计时
        }
        healthData[apiKey] = h
        healthUpdated = true
        lastError = new Response(JSON.stringify({
          error: { message: error.message || '请求失败', type: 'proxy_error' },
        }), { status: 502 })
        continue
      }
    }

    // 写回健康状态
    if (healthUpdated) await writeHealth(c.env, providerId, healthData)

    // 所有 key 均失败
    if (lastError) {
      const errorBody = await lastError.text().catch(() => '所有 API Key 均失败')
      return c.json({
        error: {
          message: `所有 API Key 已用完，最后一次错误: HTTP ${lastError.status}`,
          type: 'key_exhausted',
          detail: errorBody.substring(0, 500),
        },
      }, (lastError.status || 502) as Parameters<typeof c.json>[1])
    }

    return c.json({
      error: { message: '没有可用的 API Key', type: 'configuration_error' },
    }, 500)
  } catch (err) {
    const error = err as Error
    return c.json({
      error: { message: error.message || '代理转发内部错误', type: 'server_error' },
    }, 500)
  }
}

/** 处理 /v1/models — 返回所有已启用的模型（含提供商前缀） */
export async function handleModels(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)

  const models: Array<{
    id: string
    provider: string
    provider_name: string
    object: string
    created: number
    owned_by: string
  }> = []

  for (const provider of providers) {
    if (!provider.enabled) continue
    for (const model of provider.models) {
      if (!model.enabled) continue
      models.push({
        id: `${provider.id}/${model.id}`,
        provider: provider.id,
        provider_name: provider.name,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: provider.id,
      })
    }
  }

  return c.json({
    object: 'list',
    data: models,
  })
}
