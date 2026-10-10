/**
 * 页面与会话路由：首页、登录/退出、管理后台页面（含 /admin/* 会话闸门）。
 */
import type { Hono } from 'hono'
import type { Env } from '../types'
import { adminAuthMiddleware, handleLogin, handleLogout } from '../auth'
import { renderHomePage, renderLoginPage, renderAdminPage } from '../pages'
import { getSession } from '../storage'

export function registerPagesRoutes(app: Hono<{ Bindings: Env }>) {
  // ===== 首页 =====
  app.get('/', async (c) => {
    const { getCookie } = await import('hono/cookie')
    const sessionId = getCookie(c, 'session_id')
    let isLoggedIn = false
    if (sessionId) {
      const session = await getSession(c.env, sessionId)
      isLoggedIn = session !== null
    }
    return renderHomePage(c, isLoggedIn)
  })

  // ===== 登录/退出 =====
  app.get('/admin/login', async (c) => renderLoginPage(c))
  app.post('/admin/login', handleLogin)
  app.get('/admin/logout', handleLogout)

  // ===== 管理后台（需 Session 验证） =====
  // 顺序要紧：/admin/login、/admin/logout 必须先于这道闸门注册，否则登录页自身会被会话校验拦下
  app.use('/admin/*', adminAuthMiddleware)

  // 缓存策略与 ETag 由 renderAdminPage 内部通过 c.header() 设置：
  // Hono 的 c.header() 优先级高于此处对 res.headers 的修改，写在这里会被覆盖。
  app.get('/admin', async (c) => renderAdminPage(c))
}
