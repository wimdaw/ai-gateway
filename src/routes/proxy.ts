/**
 * API 转发路由（需转发 Key 验证）。
 *
 * 端点清单参考 one-api-cf：全部透传给 proxy 层，未实现的端点返回标准 501。
 */
import type { Context, Hono } from 'hono'
import type { Env } from '../types'
import { handleProxy, handleModels } from '../proxy'
import { proxyKeyAuthMiddleware } from '../auth'

/**
 * 未实现端点（files / fine-tuning / assistants / threads 等）。
 *
 * 用一张 { method, path } 表批量注册 —— 这些端点行为完全一样（同样的 501 + 同样的 JSON 体），
 * 原先三十来行 `app.get(...)` / `app.post(...)` 只是重复。表顺序即注册顺序，与原实现逐条一致。
 */
const NOT_IMPLEMENTED_ROUTES: Array<{ method: string; path: string }> = [
  // files
  { method: 'GET', path: '/v1/files' },
  { method: 'POST', path: '/v1/files' },
  { method: 'DELETE', path: '/v1/files/:id' },
  { method: 'GET', path: '/v1/files/:id' },
  { method: 'GET', path: '/v1/files/:id/content' },
  // fine-tuning
  { method: 'POST', path: '/v1/fine_tuning/jobs' },
  { method: 'GET', path: '/v1/fine_tuning/jobs' },
  { method: 'GET', path: '/v1/fine_tuning/jobs/:id' },
  { method: 'POST', path: '/v1/fine_tuning/jobs/:id/cancel' },
  { method: 'GET', path: '/v1/fine_tuning/jobs/:id/events' },
  // assistants
  { method: 'POST', path: '/v1/assistants' },
  { method: 'GET', path: '/v1/assistants/:id' },
  { method: 'POST', path: '/v1/assistants/:id' },
  { method: 'DELETE', path: '/v1/assistants/:id' },
  { method: 'GET', path: '/v1/assistants' },
  // threads
  { method: 'POST', path: '/v1/threads' },
  { method: 'GET', path: '/v1/threads/:id' },
  { method: 'POST', path: '/v1/threads/:id' },
  { method: 'DELETE', path: '/v1/threads/:id' },
]

/** 统一 501（响应体与重构前完全一致） */
const notImplemented = (c: Context) => c.json({
  error: { message: 'API not implemented', type: 'one_api_error', param: '', code: 'api_not_implemented' },
}, 501)

export function registerProxyRoutes(app: Hono<{ Bindings: Env }>) {
  app.use('/v1/*', proxyKeyAuthMiddleware)
  app.get('/v1/models', handleModels)

  // OpenAI 兼容代理端点（全部透传转发，参考 one-api-cf 端点清单）
  app.post('/v1/chat/completions', handleProxy)
  app.post('/v1/completions', handleProxy)
  app.post('/v1/edits', handleProxy)
  app.post('/v1/moderations', handleProxy)
  app.post('/v1/messages', handleProxy)
  app.post('/v1/responses', handleProxy)
  app.post('/v1/audio/speech', handleProxy)
  app.post('/v1/audio/transcriptions', handleProxy)
  app.post('/v1/audio/translations', handleProxy)
  app.post('/v1/images/generations', handleProxy)
  app.post('/v1/images/edits', handleProxy)
  app.post('/v1/images/variations', handleProxy)
  app.post('/v1/embeddings', handleProxy)
  app.post('/v1/engines/:model/embeddings', handleProxy)
  app.post('/v1/videos/generations', handleProxy)
  app.post('/v1/video/generations', handleProxy)
  app.get('/v1/videos/status', handleProxy)

  for (const { method, path } of NOT_IMPLEMENTED_ROUTES) {
    app.on(method, path, notImplemented)
  }

  // 兜底: 其余 /v1/* 走代理
  app.all('/v1/*', handleProxy)
}
