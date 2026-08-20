import app from './index'
import { initStorage } from './storage-adapter'

/**
 * EdgeOne Pages Functions 入口（catch-all 路由）
 * 与 Cloudflare Pages Functions 约定兼容：
 * export async function onRequest(context) — context: { request, env, params, next }
 */
export async function onRequest(context: any) {
  // 初始化 Blob 存储适配层（EdgeOne 版）
  initStorage('edgeone')
  // Hono app.fetch(request, env, executionCtx)
  return app.fetch(context.request, context.env, context)
}
