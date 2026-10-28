import crypto from 'node:crypto'

// 确保 Node.js 运行时下 Web Crypto 完整就绪
if (typeof globalThis.crypto === 'undefined') {
  // @ts-ignore
  globalThis.crypto = crypto
} else {
  if (!globalThis.crypto.randomUUID && crypto.randomUUID) {
    globalThis.crypto.randomUUID = crypto.randomUUID.bind(crypto)
  }
  if (!globalThis.crypto.subtle && (crypto as any).webcrypto) {
    // @ts-ignore
    globalThis.crypto.subtle = (crypto as any).webcrypto.subtle
  }
}

import app from './index'

/**
 * EdgeOne Makers Cloud Functions 标准入口 onRequest
 *
 * ⚠️ 关键：EdgeOne Node 运行时在高并发下会把请求体作为惰性 Node 流交给 handler，
 * 多个并发请求同时读取时会出现竞态，导致 `c.req.json()` 抛错（表现为
 * "Invalid JSON body"）。因此这里在入口处**一次性把请求体物化为 ArrayBuffer**，
 * 再用它构造一个全新的 Web Request 交给 Hono，彻底消除并发下的流竞态。
 * 请求体上限受平台约束（6MB），网关场景均为小体积 JSON，缓冲代价可忽略。
 */
export async function onRequest(context: any) {
  const incoming: Request = context.request

  const env = {
    ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'yxy.@990524gdg',
    OPENCODE_MIRRORS_URL: process.env.OPENCODE_MIRRORS_URL,
    OPENCODE_RELAY_URL: process.env.OPENCODE_RELAY_URL,
    AG_CLIENT_ID: process.env.AG_CLIENT_ID,
    AG_CLIENT_SECRET: process.env.AG_CLIENT_SECRET,
    ...process.env,
    ...(context?.env || {}),
  }

  const method = (incoming.method || 'GET').toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD'

  let request = incoming
  if (hasBody) {
    try {
      const buf = await incoming.arrayBuffer()
      request = new Request(incoming.url, {
        method,
        headers: incoming.headers,
        body: buf.byteLength > 0 ? buf : undefined,
      })
    } catch (err: any) {
      // 物化失败时退回原始 Request，交由下游报错，避免整体 500
      console.error('[Entry] Failed to materialize request body:', err?.message)
      request = incoming
    }
  }

  return await app.fetch(request, env, context)
}

// 导出 Hono 实例以供 EdgeOne 框架识别层自动支持
export default app
