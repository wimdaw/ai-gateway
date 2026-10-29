import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env } from './types'
import { adminAuthMiddleware, proxyKeyAuthMiddleware, handleLogin, handleLogout } from './auth'
import { handleProxy, handleModels } from './llm-proxy'
import { OPENCODE_RELAY_TOKEN_DEFAULT, getOpenCodeRuntimeDiagnostics } from './opencode'
import {
  handleStatus,
  handleGetProviders,
  handleProviderPanel,
  handleListProviderKeys,
  handleUpdateProviderKeys,
  handleCreateProvider,
  handleUpdateProvider,
  handleDeleteProvider,
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
  handleCronCheckin,
  handleClineQuota,
} from './admin'
import { renderHomePage, renderLoginPage, renderAdminPage } from './pages'
import { probeDeepSeek, probeDeepSeekLogin } from './deepseek-auth-probe'
import { seedInitialData, getSession } from './storage'
import { handleBackupExport, handleBackupImport, handleBackupToR2, handleBackupList, handleBackupRestore, handleBackupDelete, handleTelegramTest, handleTelegramSave, handleBackupToTelegram } from './backup'

const app = new Hono<{ Bindings: Env }>()

// ===== 全局中间件 =====
// ⚠️⚠️ 源侧 gzip 在 EdgeOne 上严禁启用（两轮实测的结论，动这块前必读）：
// 平台把源侧收到的 Accept-Encoding 一律改写为 identity。若无视它回 gzip 响应体：
//   1) 对 POST 响应回 gzip → 边缘把该域名【所有 POST】转发整体卡死（无路由 POST
//      也挂起、120s 后 504），关闭立即恢复；
//   2) 仅对 GET 响应回 gzip → 【所有 GET】整体挂起，POST 反而正常。
//   3) 完全关闭源侧 gzip → GET/POST 全部正常。
// 规律：哪种方法的响应被 gzip，哪种方法就被边缘卡死（压缩引擎与源侧压缩体冲突）。
// 页面/接口压缩交给控制台域名级的「智能压缩」配置处理，代码层不再碰。
// const COMPRESSIBLE_CT = /^(text\/html|text\/css|text\/plain|application\/javascript|application\/json)\b/i
// app.use('*', async (c, next) => {
//   await next()
//   try {
//     const res = c.res
//     if (!res || res.headers.get('Content-Encoding')) return
//     const ct = (res.headers.get('Content-Type') || '').split(';')[0].trim()
//     if (!COMPRESSIBLE_CT.test(ct)) return
//     const buf = Buffer.from(await res.arrayBuffer())
//     if (buf.byteLength < 1024) return
//     const gz = gzipSync(buf)
//     const headers = new Headers(res.headers)
//     headers.set('Content-Encoding', 'gzip')
//     headers.set('Content-Length', String(gz.byteLength))
//     headers.set('Vary', 'Accept-Encoding')
//     c.res = new Response(gz, { status: res.status, statusText: res.statusText, headers })
//   } catch {}
// })
app.use('*', cors())
app.use('*', logger())

// 首次请求时填充初始数据（基于 EdgeOne Blob 存储）
let seeded = false
app.use('*', async (c, next) => {
  if (!seeded) {
    await seedInitialData(c.env).catch((e) => console.warn('[Seed] Error:', e?.message))
    seeded = true
  }
  return next()
})

// ===== 首页 =====
// EdgeOne 平台对根路径 `/` 强制走静态文件（缺失时直接平台 404，不回落函数），
// 故部署 routes.json 中将 `/` 重写到 `/home`，由这里动态渲染，保证与后台数据同源一致。
async function renderHome(c: Context) {
  const { getCookie } = await import('hono/cookie')
  const sessionId = getCookie(c, 'session_id')
  let isLoggedIn = false
  if (sessionId) {
    const session = await getSession(c.env, sessionId)
    isLoggedIn = session !== null
  }
  return renderHomePage(c, isLoggedIn)
}
app.get('/', renderHome)
app.get('/home', renderHome)

// ===== 登录/退出 =====
app.get('/admin/login', async (c) => renderLoginPage(c))
app.post('/admin/login', handleLogin)
app.get('/admin/logout', handleLogout)

// ===== 运行时能力探针：检测 Linux x64 原生 wreq-js 是否可用 =====
app.get('/api/test-wreq', async (c) => {
  try {
    const wreq = await import('wreq-js')
    const OPENCODE_CIPHER_LIST = [
      'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
      'ECDHE-ECDSA-AES128-SHA', 'ECDHE-RSA-AES128-SHA',
      'ECDHE-ECDSA-AES256-SHA', 'ECDHE-RSA-AES256-SHA',
      'AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'AES128-SHA', 'AES256-SHA',
    ].join(':')
    const transport = wreq.createTransport({
      emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
      readTimeout: 30000,
    })
    return c.json({
      ok: true,
      message: 'wreq-js (Linux x64 Rust TLS) successfully loaded inside EdgeOne runtime!',
      hasTransport: Boolean(transport),
    })
  } catch (err) {
    return c.json({
      ok: false,
      error: (err as Error).message,
      stack: (err as Error).stack,
    }, 500)
  }
})

// ===== 静态资源（构建时内嵌进 bundle，immutable 一年期浏览器强缓存） =====
// EdgeOne makers 部署模式没有 filesystem 静态服务，只能由云函数直接下发。
import { BUNDLED_ASSETS } from './generated-assets'
app.get('/assets/:name', (c) => {
  const asset = BUNDLED_ASSETS[c.req.param('name')]
  if (!asset) return c.notFound()
  return new Response(asset.content, {
    headers: {
      'Content-Type': asset.type,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
})

// ===== 管理后台（需 Session 验证） =====
app.use('/admin/*', adminAuthMiddleware)

app.get('/admin', async (c) => {
  const res = await renderAdminPage(c)
  // 管理页含内联脚本, 禁止缓存以免浏览器长期使用旧版界面
  res.headers.set('Cache-Control', 'no-store, must-revalidate')
  return res
})

// 系统状态
app.get('/admin/api/status', handleStatus)

// 部署后自检: 拉长单次请求, 实测云函数 maxDuration (edgeone.json 配置的 120s) 是否生效
app.get('/admin/api/selftest/delay', (c) => {
  const ms = Math.min(Math.max(Number(c.req.query('ms')) || 0, 0), 150_000)
  const startedAt = Date.now()
  return new Promise<Response>((resolve) => {
    setTimeout(() => resolve(c.json({ success: true, data: { requestedMs: ms, actualMs: Date.now() - startedAt } })), ms)
  })
})

// 部署后自检: opencode 的 wreq-js 原生 TLS 通道是否就绪（false 时所有免费模型必然 429）
app.get('/admin/api/selftest/opencode', async (c) => {
  return c.json({ success: true, data: await getOpenCodeRuntimeDiagnostics() })
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

// ===== 定时任务入口（不需要管理员会话）=====
// 用由 ADMIN_PASSWORD 单向派生的专用令牌鉴权（X-Cron-Token 头 或 ?token=），权限最小化：
// 只能触发签到，拿不到任何渠道配置。见 README「每日签到」。
// 同时支持 GET/HEAD：外部存活监控（UptimeRobot / BetterStack 等）通常只能配一个 URL，
// 让它顺手把签到也触发了，就不必额外维护一套定时器。内置当日节流，高频 ping 不会重复打上游。
app.get('/cron/checkin', handleCronCheckin)
app.on('HEAD', '/cron/checkin', handleCronCheckin)
app.post('/cron/checkin', handleCronCheckin)

// ===== 备份/恢复 =====
app.get('/admin/api/backup/export', handleBackupExport)
app.post('/admin/api/backup/import', handleBackupImport)
app.post('/admin/api/backup/to-r2', handleBackupToR2)
app.get('/admin/api/backup/list', handleBackupList)
app.post('/admin/api/backup/restore', handleBackupRestore)
app.post('/admin/api/backup/delete', handleBackupDelete)
// Telegram 备份
app.post('/admin/api/telegram/test', handleTelegramTest)
app.post('/admin/api/telegram/save', handleTelegramSave)

// ===== DeepSeek 设备身份 / WAF 可达性探针（诊断用，判断「代登录」是否可行） =====
// GET  只做本地派生 + 无副作用联网探测（不提交任何凭据）
// POST 传 { email|mobile, password } 才会真实打一次 /users/login（有副作用，慎用）
app.get('/admin/api/ds-probe', async (c) => {
  try {
    return c.json(await probeDeepSeek())
  } catch (err) {
    return c.json({ error: { message: (err as Error).message || '探针失败' } }, 500)
  }
})
app.post('/admin/api/ds-probe/login', async (c) => {
  const body: any = await c.req.json().catch(() => null)
  if (!body?.password) {
    return c.json({ error: { message: '需要 password；可选 email 或 mobile(+area_code)' } }, 400)
  }
  try {
    return c.json(await probeDeepSeekLogin({
      email: body.email,
      mobile: body.mobile,
      password: body.password,
      areaCode: body.area_code,
    }))
  } catch (err) {
    return c.json({ error: { message: (err as Error).message || '登录探测失败' } }, 500)
  }
})
app.post('/admin/api/backup/to-telegram', handleBackupToTelegram)

// ===== OpenCode TLS 中继（供 Cloudflare Pages 内生协同出网） =====
// Cloudflare Pages 受 V8 Isolate 沙箱约束无法加载原生动态库，出网 TLS 指纹不符合门禁3；
// 腾讯云 EdgeOne 运行在 Linux x64 Node 20 上，内嵌 Rust 编译的 wreq-js 原生模块，
// 由这里作为内生 TLS 中继代发。实现 Cloudflare + EdgeOne 双端闭环，彻底摆脱第三方服务。
app.all('/__opencode_relay/*', async (c) => {
  const expected = c.env.OPENCODE_RELAY_TOKEN || OPENCODE_RELAY_TOKEN_DEFAULT
  if (c.req.header('x-opencode-relay-token') !== expected) {
    return c.json({ error: { message: 'invalid relay token', type: 'relay_unauthorized' } }, 401)
  }

  const url = new URL(c.req.url)
  const subPath = url.pathname.replace(/^\/__opencode_relay/, '') || '/'
  const target = 'https://opencode.ai/inference/openai/v1'
    + (subPath.startsWith('/') ? subPath : '/' + subPath)
    + url.search

  const headers: Record<string, string> = {}
  for (const name of [
    'content-type', 'authorization', 'user-agent', 'accept',
    'x-opencode-client', 'x-opencode-project',
    'x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id',
    'typesafe-danger-zone-images',
  ]) {
    const value = c.req.header(name)
    if (value) headers[name] = value
  }

  const body = c.req.method === 'GET' || c.req.method === 'HEAD'
    ? undefined
    : await c.req.arrayBuffer()

  try {
    const wreq = await import('wreq-js')
    const createTransport = wreq.createTransport || (wreq as any).default?.createTransport
    const fetchFn = wreq.fetch || (wreq as any).default?.fetch
    const OPENCODE_CIPHER_LIST = [
      'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
      'ECDHE-ECDSA-AES128-SHA', 'ECDHE-RSA-AES128-SHA',
      'ECDHE-ECDSA-AES256-SHA', 'ECDHE-RSA-AES256-SHA',
      'AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'AES128-SHA', 'AES256-SHA',
    ].join(':')
    const transport = await createTransport({
      emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
      readTimeout: 300000,
    })

    const upstream = await fetchFn(target, {
      method: c.req.method,
      headers,
      body: body ? Buffer.from(body) : undefined,
      transport,
      timeout: 300000,
    })

    const respHeaders = new Headers()
    if (upstream.headers && typeof upstream.headers.forEach === 'function') {
      upstream.headers.forEach((val: string, key: string) => {
        const lower = key.toLowerCase()
        if (lower !== 'content-length' && lower !== 'content-encoding') {
          respHeaders.set(key, val)
        }
      })
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    })
  } catch (err: any) {
    return c.json({
      error: { message: err?.message || 'relay upstream failed', type: 'relay_upstream_failed' },
    }, 502)
  }
})

// ===== API 转发路由（需转发 Key 验证） =====
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

// 未实现端点（files / fine-tuning / assistants / threads 等, 返回标准 501）
const notImplemented = (c: Context) => c.json({
  error: { message: 'API not implemented', type: 'one_api_error', param: '', code: 'api_not_implemented' },
}, 501)
// files
app.get('/v1/files', notImplemented)
app.post('/v1/files', notImplemented)
app.delete('/v1/files/:id', notImplemented)
app.get('/v1/files/:id', notImplemented)
app.get('/v1/files/:id/content', notImplemented)
// fine-tuning
app.post('/v1/fine_tuning/jobs', notImplemented)
app.get('/v1/fine_tuning/jobs', notImplemented)
app.get('/v1/fine_tuning/jobs/:id', notImplemented)
app.post('/v1/fine_tuning/jobs/:id/cancel', notImplemented)
app.get('/v1/fine_tuning/jobs/:id/events', notImplemented)
// assistants
app.post('/v1/assistants', notImplemented)
app.get('/v1/assistants/:id', notImplemented)
app.post('/v1/assistants/:id', notImplemented)
app.delete('/v1/assistants/:id', notImplemented)
app.get('/v1/assistants', notImplemented)
// threads
app.post('/v1/threads', notImplemented)
app.get('/v1/threads/:id', notImplemented)
app.post('/v1/threads/:id', notImplemented)
app.delete('/v1/threads/:id', notImplemented)

// 兜底: 其余 /v1/* 走代理
app.all('/v1/*', handleProxy)

// ===== 404 处理 =====
app.notFound((c) => {
  return c.json({ error: { message: '接口不存在', type: 'not_found' } }, 404)
})

// ===== 错误处理 =====
app.onError((err, c) => {
  console.error('未捕获的错误:', err)
  return c.json({ error: { message: '服务器内部错误', type: 'server_error' } }, 500)
})

export default app
