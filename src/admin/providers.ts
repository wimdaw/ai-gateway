/**
 * 渠道相关管理端接口：系统状态 + 渠道 CRUD + Key 增量维护。
 */
import { Context } from 'hono'
import { ok, fail, requireParam } from '../http'
import { getProviders, getProvider, addProvider, updateProvider, deleteProvider, getProxyKeys, getAdminCredentials } from '../storage'
import { OPENCODE_DEFAULT_URL } from '../config'
import type { Env, Provider, CreateProviderRequest, UpdateProviderRequest } from '../types'
import { KEY_PREVIEW, normalizeArray, normalizeMirrorUrls, normalizeModels, normalizeRegion, redactProvider } from './common'
import { renderProviderPanel } from '../admin.page'

// ===== 系统状态 =====

export async function handleStatus(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const proxyKeys = await getProxyKeys(c.env)

  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0)
  const enabledModels = providers.reduce(
    (sum, p) => sum + p.models.filter((m) => m.enabled).length,
    0
  )

  return ok(c, {
      providersCount: providers.length,
      enabledProvidersCount: providers.filter((p) => p.enabled).length,
      modelsCount: totalModels,
      enabledModelsCount: enabledModels,
      proxyKeysCount: proxyKeys.filter((k) => k.enabled).length,
      adminConfigured: !!(c.env.ADMIN_USERNAME && c.env.ADMIN_PASSWORD) || (await getAdminCredentials(c.env)) !== null,
      baseUrl: new URL(c.req.url).origin,
    })
}

// ===== 渠道 CRUD =====

/**
 * 单个渠道的编辑面板 HTML（懒加载）。
 *
 * 面板占地很大（14 个渠道合计数百 KiB），但默认折叠、多数时候不会被打开，
 * 因此列表页只渲染摘要，展开时才取这一段。返回 HTML 而非 JSON，前端直接注入。
 */
export async function handleProviderPanel(c: Context<{ Bindings: Env }>) {
  const id = requireParam(c, 'id')
  if (id instanceof Response) return id
  const provider = await getProvider(c.env, id)
  if (!provider) return fail(c, '渠道不存在', 404)
  return c.html(renderProviderPanel(provider))
}

export async function handleGetProviders(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const full = c.req.query('full') === '1'
  const data = providers.map((p) => {
    // 必须浅拷贝: redactProvider 无 dsAccount 时返回原引用, 直接截断会污染缓存
    const rp: any = { ...redactProvider(p) }
    const total = (rp.apiKeys || []).length
    rp.apiKeysTotal = total
    if (!full && total > KEY_PREVIEW) {
      rp.apiKeys = rp.apiKeys.slice(0, KEY_PREVIEW)
      rp.apiKeysTruncated = true
    }
    return rp
  })
  return ok(c, data)
}

// 分页拉取某渠道的 Key 列表(支持子串搜索), 供前端「查看更多」使用
export async function handleListProviderKeys(c: Context<{ Bindings: Env }>) {
  // 路径参数兜底：缺失时返回 400，而不是把 string | undefined 交给要求 string 的函数
  const id = requireParam(c, 'id')
  if (id instanceof Response) return id
  const provider = await getProvider(c.env, id)
  if (!provider) return fail(c, '渠道不存在', 404)
  const size = Math.min(500, Math.max(1, parseInt(c.req.query('size') || '100', 10) || 100))
  const q = (c.req.query('q') || '').toLowerCase()
  const all = provider.apiKeys || []
  const filtered = q ? all.filter((k) => k.key.toLowerCase().includes(q)) : all
  const offsetQ = c.req.query('offset')
  const start = offsetQ !== undefined && offsetQ !== null && !isNaN(parseInt(offsetQ, 10))
    ? Math.max(0, parseInt(offsetQ, 10))
    : (Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1) - 1) * size
  const keys = filtered.slice(start, start + size)
  return ok(c, { keys, total: all.length, matched: filtered.length, offset: start, size, hasMore: start + size < filtered.length })
}

// 增量维护 Key: { add: string[], remove: string[], enable: string[], disable: string[] }
// 大量 Key 的渠道(上万)不再由前端整包提交, 避免覆盖未加载的 Key
export async function handleUpdateProviderKeys(c: Context<{ Bindings: Env }>) {
  // 路径参数兜底：缺失时返回 400，而不是把 string | undefined 交给要求 string 的函数
  const id = requireParam(c, 'id')
  if (id instanceof Response) return id
  const provider = await getProvider(c.env, id)
  if (!provider) return fail(c, '渠道不存在', 404)
  const body = await c.req.json<{ add?: string[]; remove?: string[]; enable?: string[]; disable?: string[] }>()
  const map = new Map<string, { key: string; enabled: boolean }>()
  for (const k of provider.apiKeys || []) map.set(k.key, { key: k.key, enabled: !!k.enabled })
  let changed = 0
  for (const raw of body.add || []) {
    const key = String(raw || '').trim()
    if (key && !map.has(key)) { map.set(key, { key, enabled: true }); changed++ }
  }
  for (const raw of body.remove || []) {
    if (map.delete(String(raw || '').trim())) changed++
  }
  for (const raw of body.enable || []) {
    const it = map.get(String(raw || '').trim())
    if (it && !it.enabled) { it.enabled = true; changed++ }
  }
  for (const raw of body.disable || []) {
    const it = map.get(String(raw || '').trim())
    if (it && it.enabled) { it.enabled = false; changed++ }
  }
  if (!changed) {
    return ok(c, { total: map.size, changed: 0 })
  }
  const updated = await updateProvider(c.env, id, {
    apiKeys: Array.from(map.values()),
    updatedAt: new Date().toISOString(),
  })
  if (!updated) return fail(c, '渠道不存在', 404)
  return ok(c, { total: updated.apiKeys.length, changed })
}

export async function handleCreateProvider(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<CreateProviderRequest>()
  // opencode 未传地址时自动填充
  if (body.id === 'opencode' && !body.baseUrl) {
    body.baseUrl = OPENCODE_DEFAULT_URL
  }

  if (!body.id || !body.name || !body.baseUrl) {
    return fail(c, 'id、name、baseUrl 为必填项', 400)
  }

  const providers = await getProviders(c.env)
  if (providers.some((p) => p.id === body.id)) {
    return fail(c, `渠道 id "${body.id}" 已存在`, 409)
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
    project: body.project,
    location: body.location,
    region: normalizeRegion(body.region),
    voice: body.voice,
    rate: body.rate,
    volume: body.volume,
    pitch: body.pitch,
    enabled: body.enabled !== undefined ? body.enabled : true,
    createdAt: now,
    updatedAt: now,
  }

  await addProvider(c.env, provider)
  return ok(c, provider, undefined, 201)
}

export async function handleUpdateProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return fail(c, '缺少 id 参数', 400)
  const body = await c.req.json<UpdateProviderRequest>()

  // 重命名目标必须先校验、再落库。
  // 原实现是「先 updateProvider 落库，后校验 newId」——校验失败时虽然返回 400，
  // 但改动其实已经写进存储了（数据一致性缺陷）。这里把校验前移。
  if (body.newId && body.newId !== id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(body.newId)) {
      return fail(c, 'ID 只能包含字母/数字/下划线/连字符', 400)
    }
    const existing = await getProvider(c.env, body.newId)
    if (existing) {
      return fail(c, `渠道 ID "${body.newId}" 已存在`, 400)
    }
  }

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
  if (body.project !== undefined) updates.project = body.project
  if (body.location !== undefined) updates.location = body.location
  if (body.region !== undefined) updates.region = normalizeRegion(body.region)
  if (body.apiKeys !== undefined) {
    updates.apiKeys = normalizeArray(body.apiKeys, (k) => ({ key: k, enabled: true }))
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled
  if (body.models !== undefined) {
    updates.models = normalizeModels(body.models)
  }

  const updated = await updateProvider(c.env, id, updates)
  if (!updated) {
    return fail(c, '渠道不存在', 404)
  }

  // 支持重命名渠道 ID: 删除旧 ID, 用新 ID 重建(保留完整配置)
  // newId 的合法性与唯一性已在落库前校验，这里只执行重命名动作。
  if (body.newId && body.newId !== id) {
    const renamed = { ...updated, id: body.newId, updatedAt: new Date().toISOString() }
    await deleteProvider(c.env, id)
    await addProvider(c.env, renamed)
    return ok(c, renamed, '渠道 ID 已更新')
  }

  return ok(c, updated)
}

export async function handleDeleteProvider(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return fail(c, '缺少 id 参数', 400)
  const deleted = await deleteProvider(c.env, id)
  if (!deleted) {
    return fail(c, '渠道不存在', 404)
  }
  return ok(c, undefined, '渠道已删除')
}

