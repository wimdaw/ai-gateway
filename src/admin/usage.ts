/**
 * Token 用量统计。
 */
import { Context } from 'hono'
import { ok } from '../http'
import { getUsageSummary } from '../storage'
import type { Env } from '../types'

// ===== Token 用量统计 =====

export async function handleGetUsage(c: Context<{ Bindings: Env }>) {
  const q = c.req.query('days')
  // 默认显示今天(1天)
  const days = Math.min(Math.max(parseInt(q || '1') || 1, 1), 30)
  const summary = await getUsageSummary(c.env, days)
  return ok(c, summary)
}

