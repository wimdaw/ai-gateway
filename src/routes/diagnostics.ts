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
  // 临时诊断：从本 Worker 出口探测 OpenCode 上游（区分「注入链路问题」与「出口 IP 被拒」）
  app.get('/admin/api/oc-probe', async (c) => {
    try {
      const { getProvider } = await import('../storage')
      const { proxyOpenCodeRequest, resolveProviderMirrorUrls, ensureOpenCodeCompat } = await import('../opencode')
      const { OPENCODE_CLI_MARKER, OPENCODE_OFFICIAL_TOOLS } = await import('../opencode-compat')

      const provider = await getProvider(c.env, 'opencode')
      if (!provider) return apiError(c, 'opencode provider 未配置', 404)

      const basePayload: Record<string, any> = {
        model: 'big-pickle',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }
      const injected = JSON.parse(JSON.stringify(basePayload))
      ensureOpenCodeCompat(injected)

      // 探针 A：完整网关注入链路（与 test-model 相同）
      const responseA = await proxyOpenCodeRequest({
        baseUrl: provider.baseUrl,
        apiKeys: provider.apiKeys.filter((k) => k.enabled && k.key),
        method: 'POST',
        subPath: 'chat/completions',
        body: JSON.stringify(basePayload),
        mirrorUrls: resolveProviderMirrorUrls(c.env, provider),
      })
      const bodyA = await responseA.text()

      // 探针 B：硬编码「官方形态」请求（官方 CLI marker + 官方 11 工具全集），绕开注入逻辑
      const payloadB = {
        model: 'big-pickle',
        max_tokens: 32,
        messages: [
          { role: 'system', content: OPENCODE_CLI_MARKER },
          { role: 'user', content: 'hi' },
        ],
        stream: true,
        tools: OPENCODE_OFFICIAL_TOOLS,
      }
      const upstreamUrl = provider.baseUrl.replace(/\/zen\/v1(?=\/|$)/, '/inference/v1').replace(/\/+$/, '') + '/chat/completions'
      const probeSessionId = 'ses_' + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
      const responseB = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer public',
          'User-Agent': 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
          'x-opencode-client': 'cli',
          'x-opencode-project': 'global',
          'x-opencode-session': probeSessionId,
          'x-opencode-session-id': probeSessionId,
        },
        body: JSON.stringify(payloadB),
      })
      const bodyB = await responseB.text()

      return c.json({
        providerBaseUrl: provider.baseUrl,
        mirrorUrls: provider.mirrorUrls,
        injectedBodyLength: JSON.stringify(injected).length,
        injectedBodyHead: JSON.stringify(injected).slice(0, 260),
        probeA: { status: responseA.status, bodyHead: bodyA.slice(0, 400) },
        probeB: { url: upstreamUrl, status: responseB.status, bodyHead: bodyB.slice(0, 400) },
      })
    } catch (err) {
      return apiError(c, (err as Error).message || 'oc-probe 失败', 500)
    }
  })

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
