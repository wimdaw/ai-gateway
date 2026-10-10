/**
 * 诊断路由：DeepSeek 设备身份 / WAF 可达性探针。
 *
 * GET  只做本地派生 + 无副作用联网探测（不提交任何凭据）
 * POST 传 { email|mobile, password } 才会真实打一次 /users/login（有副作用，慎用）
 */
import type { Hono } from 'hono'
import type { Env } from '../types'
import { apiError } from '../http'
import { probeDeepSeek, probeDeepSeekLogin } from '../deepseek-auth-probe'
import { registerBackupToTelegramRoute } from './backup'

export function registerDiagnosticsRoutes(app: Hono<{ Bindings: Env }>) {
  app.get('/admin/api/ds-probe', async (c) => {
    try {
      return c.json(await probeDeepSeek())
    } catch (err) {
      return apiError(c, (err as Error).message || '探针失败', 500)
    }
  })

  app.post('/admin/api/ds-probe/login', async (c) => {
    const body: any = await c.req.json().catch(() => null)
    if (!body?.password) {
      return apiError(c, '需要 password；可选 email 或 mobile(+area_code)', 400)
    }
    try {
      return c.json(await probeDeepSeekLogin({
        email: body.email,
        mobile: body.mobile,
        password: body.password,
        areaCode: body.area_code,
      }))
    } catch (err) {
      return apiError(c, (err as Error).message || '登录探测失败', 500)
    }
  })

  // 注册位置沿用原实现（紧跟 ds-probe 之后），保证路由表逐条一致
  registerBackupToTelegramRoute(app)
}
