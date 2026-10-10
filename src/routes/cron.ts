/**
 * 定时任务入口（不需要管理员会话）。
 *
 * 用由 ADMIN_PASSWORD 单向派生的专用令牌鉴权（X-Cron-Token 头 或 ?token=），权限最小化：
 * 只能触发签到，拿不到任何渠道配置。见 README「每日签到」。
 * 同时支持 GET/HEAD：外部存活监控（UptimeRobot / BetterStack 等）通常只能配一个 URL，
 * 让它顺手把签到也触发了，就不必额外维护一套定时器。内置当日节流，高频 ping 不会重复打上游。
 */
import type { Hono } from 'hono'
import type { Env } from '../types'
import { handleCronCheckin } from '../admin'

export function registerCronRoutes(app: Hono<{ Bindings: Env }>) {
  app.get('/cron/checkin', handleCronCheckin)
  app.on('HEAD', '/cron/checkin', handleCronCheckin)
  app.post('/cron/checkin', handleCronCheckin)
}
