/**
 * 本机 OpenCode 中继（Bun）
 *
 * 背景：opencode.ai 免费层现在按出口 IP 判定，云厂商 IP（EdgeOne / Koyeb / CF）
 * 会直接 429 FreeUsageLimitError；而官方客户端从本机住宅 IP 可以正常使用。
 * 这个中继跑在本机，用 Bun 原生 fetch 出网，再由 Cloudflare Tunnel 暴露给
 * EdgeOne / Pages 等云端网关代发请求。
 *
 * 启动：
 *   OPENCODE_RELAY_TOKEN=<token> bun scripts/opencode-relay.ts
 * 默认监听 127.0.0.1:8788，路径前缀 /__opencode_relay/。
 */
const DEFAULT_TOKEN = 'oc_relay_2f4c8a1d6b9e3f70c5a2d84b1e6f9073'
const TOKEN = (process.env.OPENCODE_RELAY_TOKEN || DEFAULT_TOKEN).trim()
const PORT = Number(process.env.PORT || 8788)
const UPSTREAM = 'https://opencode.ai/inference/openai/v1'

const FORWARD_HEADERS = [
  'content-type', 'authorization', 'user-agent', 'accept',
  'x-opencode-client', 'x-opencode-project',
  'x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id',
  'typesafe-danger-zone-images',
]

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/health') {
      return Response.json({ ok: true, bun: Bun.version })
    }
    if (!url.pathname.startsWith('/__opencode_relay/')) {
      return Response.json({ error: { message: 'not found' } }, { status: 404 })
    }
    if (req.headers.get('x-opencode-relay-token') !== TOKEN) {
      return Response.json({ error: { message: 'invalid relay token', type: 'relay_unauthorized' } }, { status: 401 })
    }

    const subPath = url.pathname.slice('/__opencode_relay'.length) || '/'
    const target = UPSTREAM + (subPath.startsWith('/') ? subPath : '/' + subPath) + url.search
    const headers = new Headers()
    for (const name of FORWARD_HEADERS) {
      const value = req.headers.get(name)
      if (value) headers.set(name, value)
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
    const started = Date.now()
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(300000),
      })
      const respHeaders = new Headers(upstream.headers)
      respHeaders.delete('content-length')
      respHeaders.delete('content-encoding')
      console.log(`[relay] ${req.method} ${subPath} -> ${upstream.status} ${Date.now() - started}ms`)
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      })
    } catch (err) {
      console.error('[relay] upstream failed:', err)
      return Response.json({ error: { message: (err as Error).message || 'relay upstream failed', type: 'relay_upstream_failed' } }, { status: 502 })
    }
  },
})

console.log(`[relay] listening on http://127.0.0.1:${server.port} (Bun ${Bun.version})`)
