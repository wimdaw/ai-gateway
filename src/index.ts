/**
 * Cloudflare Pages Functions 入口：只做组装。
 *
 * 具体实现按域拆在：
 *   ./middleware/bootstrap  D1 建表 + 首次种子数据（isolate 级 promise 缓存）
 *   ./routes/pages          首页 / 登录退出 / 管理页（含 /admin/* 会话闸门）
 *   ./routes/admin-api      /admin/api/* 全部管理端接口
 *   ./routes/cron           /cron/checkin
 *   ./routes/backup         /admin/api/backup/*、/admin/api/telegram/*
 *   ./routes/diagnostics    /admin/api/ds-probe*、/admin/api/backup/to-telegram
 *   ./routes/proxy          /v1/*（转发 Key 鉴权 + 代理 + 未实现端点 501）
 *   ./http                  ok / fail / apiError / requireParam 响应助手
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env } from './types'
import { apiError } from './http'
import { bootstrapMiddleware } from './middleware/bootstrap'
import { registerPagesRoutes } from './routes/pages'
import { registerAdminApiRoutes } from './routes/admin-api'
import { registerCronRoutes } from './routes/cron'
import { registerBackupRoutes } from './routes/backup'
import { registerDiagnosticsRoutes } from './routes/diagnostics'
import { registerProxyRoutes } from './routes/proxy'

const app = new Hono<{ Bindings: Env }>()

// ===== 全局中间件 =====
app.use('*', cors())
app.use('*', logger())
app.use('*', bootstrapMiddleware)

// ===== 路由注册 =====
// 注册顺序即匹配优先级（例如 /admin/login 必须先于 /admin/* 闸门），与原实现一致
registerPagesRoutes(app)
registerAdminApiRoutes(app)
registerCronRoutes(app)
registerBackupRoutes(app)
registerDiagnosticsRoutes(app)
registerProxyRoutes(app)

// ===== 404 处理 =====
app.notFound((c) => apiError(c, '接口不存在', 404, 'not_found'))

// ===== 错误处理 =====
app.onError((err, c) => {
  console.error('未捕获的错误:', err)
  return apiError(c, '服务器内部错误', 500, 'server_error')
})

export default app
