/**
 * 转发令牌（proxy key）管理。
 */
import { Context } from 'hono'
import { ok, fail } from '../http'
import { getProxyKeys, addProxyKey, updateProxyKey, deleteProxyKey } from '../storage'
import { PROXY_KEY_PREFIX, EXPIRY_OPTIONS } from '../config'
import type { Env, CreateProxyKeyRequest } from '../types'

// ===== 令牌管理 =====

export async function handleGetProxyKeys(c: Context<{ Bindings: Env }>) {
  const keys = await getProxyKeys(c.env)
  const maskedKeys = keys.map((k) => ({
    ...k,
    key: k.key.length > 12
      ? k.key.substring(0, 8) + '****' + k.key.substring(k.key.length - 4)
      : k.key,
  }))
  return ok(c, maskedKeys)
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
  return ok(c, proxyKey, '请立即保存此 Key，关闭后将不再显示', 201)
}

export async function handleDeleteProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return fail(c, '缺少 id 参数', 400)
  const deleted = await deleteProxyKey(c.env, id)
  if (!deleted) {
    return fail(c, '令牌不存在', 404)
  }
  return ok(c, undefined, '令牌已删除')
}

export async function handleUpdateProxyKey(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return fail(c, '缺少 id 参数', 400)
  const body = await c.req.json<{ enabled?: boolean; regenerate?: boolean }>()
  const updates: Partial<import('../types').ProxyKey> = {}
  if (body.enabled !== undefined) updates.enabled = body.enabled
  // 重新生成: 生成新的 key 值(旧 key 立即失效)
  if (body.regenerate) {
    const randomPart = crypto.randomUUID().replace(/-/g, '')
    updates.key = `${PROXY_KEY_PREFIX}${randomPart}`
    updates.createdAt = new Date().toISOString()
  }
  const updated = await updateProxyKey(c.env, id, updates)
  if (!updated) {
    return fail(c, '令牌不存在', 404)
  }
  return ok(c, updated)
}

