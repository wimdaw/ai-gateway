/**
 * 管理后台 API 路由（全部位于 /admin/* 会话闸门之后，见 routes/pages.ts）。
 *
 * 注册顺序即 Hono 的匹配优先级，与原 src/index.ts 逐条一致，勿随意调整。
 */
import type { Hono } from 'hono'
import type { Env } from '../types'
import {
  handleStatus,
  handleGetProviders,
  handleListProviderKeys,
  handleUpdateProviderKeys,
  handleCreateProvider,
  handleUpdateProvider,
  handleDeleteProvider,
  handleProviderPanel,
  handleTestModel,
  handleTestKeyNew,
  handleTestModelNew,
  handleSaveDsAccount,
  handleDsLogin,
  handleClearDsAccount,
  handleGetProxyKeys,
  handleCreateProxyKey,
  handleUpdateProxyKey,
  handleDeleteProxyKey,
  handleGetUsage,
  handleTtsPreview,
  handleAntigravityOAuthStart,
  handleAntigravityOAuthComplete,
  handleAntigravityModels,
  handleAntigravityQuotaAll,
  handleAntigravityAccounts,
  handleVertexVerify,
  handleDevinOAuthStart,
  handleDevinOAuthComplete,
  handleDevinVerify,
  handleOAuthStart,
  handleOAuthComplete,
  handleOAuthPoll,
  handleOAuthModels,
  handleCodebuddyStatus,
  handleCodebuddyCheckin,
  handleClineQuota,
} from '../admin'

export function registerAdminApiRoutes(app: Hono<{ Bindings: Env }>) {
  // 系统状态
  app.get('/admin/api/status', handleStatus)

  // 部署后自检: 拉长单次请求, 实测平台单请求时长上限是否生效
  app.get('/admin/api/selftest/delay', (c) => {
    const ms = Math.min(Math.max(Number(c.req.query('ms')) || 0, 0), 600_000)
    const startedAt = Date.now()
    return new Promise<Response>((resolve) => {
      setTimeout(() => resolve(c.json({ success: true, data: { requestedMs: ms, actualMs: Date.now() - startedAt } })), ms)
    })
  })

  // 部署后自检(流式): 每 tick 吐一个字节, 用于区分「总时长上限」与「无数据超时」
  app.get('/admin/api/selftest/stream', (c) => {
    const ms = Math.min(Math.max(Number(c.req.query('ms')) || 0, 0), 900_000)
    const tickMs = Math.min(Math.max(Number(c.req.query('tick')) || 1000, 100), 10_000)
    const startedAt = Date.now()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        let sent = 0
        const timer = setInterval(() => {
          controller.enqueue(enc.encode(`tick ${sent++} @${Date.now() - startedAt}ms\n`))
          if (Date.now() - startedAt >= ms) {
            clearInterval(timer)
            controller.enqueue(enc.encode(`done actualMs=${Date.now() - startedAt}\n`))
            controller.close()
          }
        }, tickMs)
      },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } })
  })

  // 提供商 CRUD
  app.get('/admin/api/providers', handleGetProviders)
  app.get('/admin/api/providers/:id/keys', handleListProviderKeys)
// 渠道编辑面板（懒加载）：列表页不预先渲染，展开时才取
app.get('/admin/api/providers/:id/panel', handleProviderPanel)
  app.post('/admin/api/providers/:id/keys', handleUpdateProviderKeys)
  app.post('/admin/api/providers', handleCreateProvider)
  app.put('/admin/api/providers/:id', handleUpdateProvider)
  app.delete('/admin/api/providers/:id', handleDeleteProvider)
  app.post('/admin/api/providers/:id/test-model', handleTestModel)
  // DeepSeek 账号托管（方案 B：网关代登录换 userToken）
  app.put('/admin/api/providers/:id/ds-account', handleSaveDsAccount)
  app.post('/admin/api/providers/:id/ds-login', handleDsLogin)
  app.delete('/admin/api/providers/:id/ds-account', handleClearDsAccount)
  app.post('/admin/api/test-key', handleTestKeyNew)
  app.post('/admin/api/test-model', handleTestModelNew)

  // 转发 Key 管理
  app.get('/admin/api/proxy-keys', handleGetProxyKeys)
  app.post('/admin/api/proxy-keys', handleCreateProxyKey)
  app.delete('/admin/api/proxy-keys/:id', handleDeleteProxyKey)
  app.patch('/admin/api/proxy-keys/:id', handleUpdateProxyKey)

  // Token 用量统计
  app.get('/admin/api/usage', handleGetUsage)

  // Azure TTS 音色试听(管理员会话, 返回 audio/mpeg)
  app.post('/admin/api/tts-preview', handleTtsPreview)

  // Antigravity 内置 OAuth 授权 + 可用模型(管理员会话)
  app.post('/admin/api/antigravity/oauth/start', handleAntigravityOAuthStart)
  app.post('/admin/api/antigravity/oauth/complete', handleAntigravityOAuthComplete)
  app.post('/admin/api/antigravity/models', handleAntigravityModels)
  app.post('/admin/api/antigravity/quota', handleAntigravityQuotaAll)
  app.post('/admin/api/antigravity/accounts', handleAntigravityAccounts)
  app.post('/admin/api/vertex/verify', handleVertexVerify)
  app.post('/admin/api/devin/oauth/start', handleDevinOAuthStart)
  app.post('/admin/api/devin/oauth/complete', handleDevinOAuthComplete)
  app.post('/admin/api/devin/verify', handleDevinVerify)

  // OAuth 反代渠道内置授权(claude/codex: 授权链接; kimi/grok: 设备码轮询)
  app.post('/admin/api/oauth/:provider/start', handleOAuthStart)
  app.post('/admin/api/oauth/:provider/complete', handleOAuthComplete)
  app.post('/admin/api/oauth/:provider/poll', handleOAuthPoll)
  app.post('/admin/api/oauth/:provider/models', handleOAuthModels)

  // CodeBuddy 账号状态（积分/套餐余额）
  app.post('/admin/api/codebuddy/status', handleCodebuddyStatus)

  // Cline 额度页（全部渠道各凭据的余额 + 各模型今日用量/冷却状态）
  app.post('/admin/api/cline/quota', handleClineQuota)

  // CodeBuddy 每日签到（单账号；body.all=true 时遍历全部 codebuddy 渠道，供定时任务）
  app.post('/admin/api/codebuddy/checkin', handleCodebuddyCheckin)
}
