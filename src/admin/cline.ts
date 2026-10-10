/**
 * Cline 额度页（账号余额 + 各模型今日用量/冷却状态）。
 */
import { Context } from 'hono'
import { ok } from '../http'
import { getProviders } from '../storage'
import { fetchClineKeyQuota } from '../cline'
import type { Env } from '../types'

// ===== Cline 额度页（账号余额 + 各模型今日用量/冷却状态） =====

/** 查询全部 cline 渠道各凭据的账号余额、各模型今日用量与冷却状态（额度页「查询 Cline 账号」数据源） */
export async function handleClineQuota(c: Context<{ Bindings: Env }>) {
  const providers = (await getProviders(c.env)).filter((p) => p.type === 'cline')
  const channels = await Promise.all(providers.map(async (p) => {
    const keys = p.apiKeys.filter((k) => k.enabled).map((k) => k.key)
    const accounts = await Promise.all(keys.map((k) => fetchClineKeyQuota(c.env, k)))
    return { id: p.id, name: p.name, accounts }
  }))
  return ok(c, { channels })
}

