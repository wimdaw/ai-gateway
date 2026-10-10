/**
 * 管理端公共工具：入参归一化、渠道脱敏、上游响应归一化。
 */
import type { Provider, Model } from '../types'

/**
 * 将 string[] 或正规对象数组统一转换为正规对象数组
 * 例: ["k1","k2"] → [{key:"k1",enabled:true},{key:"k2",enabled:true}]
 */
export function normalizeArray<T>(
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
export function normalizeMirrorUrls(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const parts = Array.isArray(value)
    ? value as string[]
    : String(value).split('\n').flatMap(s => s.split(',')).map(s => s.trim())
  const cleaned = [...new Set(parts.map(s => String(s).trim()).filter(Boolean))]
  return cleaned.length > 0 ? cleaned : undefined
}

/**
 * 归一化渠道区域（仅 codebuddy 使用）：只接受 'cn' | 'global'，
 * 其它值（含空串/null）一律返回 undefined —— 表示「未指定」，由 baseUrl 回退判定。
 */
export function normalizeRegion(value: unknown): 'cn' | 'global' | undefined {
  return value === 'cn' || value === 'global' ? value : undefined
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
export function normalizeModels(value: unknown): Model[] {
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

// ===== 渠道脱敏 =====

/**
 * 对返回给前端的 provider 做脱敏：密文本身不必出网（前端只需要知道「有没有密码」）。
 * 把 passwordEnc 换成布尔标记 hasPassword，避免密文在浏览器/日志里流转。
 */
export function redactProvider(p: Provider): Provider & { dsAccount?: Record<string, unknown> } {
  if (!p.dsAccount) return p
  const { passwordEnc, userToken, ...rest } = p.dsAccount
  return {
    ...p,
    dsAccount: {
      ...rest,
      hasPassword: !!passwordEnc,
      tokenPreview: userToken ? `${userToken.slice(0, 8)}…${userToken.slice(-4)}` : '',
      tokenSet: !!userToken,
    } as unknown as Provider['dsAccount'],
  }
}

export const KEY_PREVIEW = 10

// ===== 请求头 / 上游响应归一化 =====

export function buildAuthHeaders(apiKey: string, apiType?: string): Record<string, string> {
  if (apiType === 'anthropic') {
    const h: Record<string, string> = { 'anthropic-version': '2023-06-01' }
    if (apiKey) h['x-api-key'] = apiKey
    return h
  }
  if (!apiKey) return {}
  return { 'Authorization': `Bearer ${apiKey}` }
}

/**
 * 归一化各上游模型列表响应为 OpenAI 兼容的 { object: 'list', data: [{ id, ... }] } 格式。
 * 兼容标准 OpenAI（data 数组）、TypeSafe（models 数组且字段为 name）、纯字符串数组等非标结构。
 */
export function normalizeModelsResponse(raw: unknown): { object: string; data: Array<Record<string, unknown>> } {
  if (!raw || typeof raw !== 'object') return { object: 'list', data: [] }
  let list: unknown[] = []
  if (Array.isArray(raw)) {
    list = raw
  } else if (Array.isArray((raw as any).data)) {
    list = (raw as any).data
  } else if (Array.isArray((raw as any).models)) {
    list = (raw as any).models
  }

  const normalized = list.map((item) => {
    if (typeof item === 'string') return { id: item }
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>
      const id = String(rec.id || rec.name || rec.model || '')
      return { ...rec, id }
    }
    return { id: String(item) }
  }).filter((item) => Boolean(item.id))

  return { object: 'list', data: normalized }
}

/**
 * 从 /models 响应中过滤出免费模型。
 * 兼容 OpenAI 兼容格式（data: [{ id, ... }]）与 OpenRouter/kilo 格式（pricing.prompt === '0' 或 id 含 :free / /free）。
 */
export function filterFreeModels(data: unknown): unknown {
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

