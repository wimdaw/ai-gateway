// 本地全链路自测：验证 EdgeOne 产物 onRequest（内存兜底模式，无需 Pages 凭据）
import('./cloud-functions/[[path]].js').then(async (m) => {
  const base = 'https://aigw.local'
  // 模拟 EdgeOne 控制台配置的管理员环境变量；存储走内存兜底（无 Pages 凭据）
  const env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'yxy.@990524gdg' }

  const call = async (path, opts = {}) => {
    const req = new Request(base + path, opts)
    const res = await m.onRequest({ request: req, env, params: {}, next: () => new Response('next') })
    const text = await res.text().catch(() => '')
    let json = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, text, json, headers: res.headers }
  }

  const results = []
  const ok = (name, cond, extra = '') => {
    results.push(`${cond ? '✅' : '❌'} ${name}${extra ? ' | ' + extra : ''}`)
  }

  // 1. 首页
  let r = await call('/')
  ok('GET / → 200 HTML', r.status === 200 && r.text.includes('<html'), `status=${r.status}`)

  // 2. 未登录访问 /admin → 302 到登录页
  r = await call('/admin')
  ok('GET /admin 未登录 → 302', r.status === 302 || r.status === 303, `status=${r.status}`)

  // 3. 登录（正确密码）→ 200 + session cookie
  r = await call('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'yxy.@990524gdg' }),
  })
  const setCookie = r.headers.get('set-cookie') || ''
  const sid = (setCookie.match(/session_id=([^;]+)/) || [])[1] || ''
  ok('POST /admin/login 正确密码 → 200 + success + cookie',
    r.status === 200 && r.json?.success === true && !!sid,
    `status=${r.status} success=${r.json?.success} cookie=${sid ? '有' : '无'}`)

  const authHeaders = { Cookie: `session_id=${sid}` }

  // 4. 带 cookie 访问 /admin → 200 HTML
  r = await call('/admin', { headers: authHeaders })
  ok('GET /admin 带 session → 200 HTML', r.status === 200 && r.text.includes('<html'), `status=${r.status}`)

  // 5. 带 cookie 查 providers → data 数组 + seed 数据（内存兜底读写验证）
  r = await call('/admin/api/providers', { headers: authHeaders })
  const providers = r.json?.data
  ok('GET /admin/api/providers → 200 + 渠道列表(内存兜底 seed)',
    r.status === 200 && Array.isArray(providers) && providers.length > 0,
    `status=${r.status} 渠道数=${Array.isArray(providers) ? providers.length : 'N/A'}`)

  // 6. 创建渠道并读回（内存兜底写读验证）
  if (Array.isArray(providers)) {
    r = await call('/admin/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        id: 'test-mem',
        name: 'Test Mem',
        type: 'openai',
        baseUrl: 'https://example.com/v1',
        apiKey: 'sk-test',
        models: [{ id: 'test-model', name: 'Test Model' }],
        enabled: true,
      }),
    })
    const created = r.json
    const createdId = created?.data?.id ?? created?.data?.providerId ?? (created?.success ? 'test-mem' : null)
    r = await call('/admin/api/providers', { headers: authHeaders })
    const providers2 = r.json?.data
    const found = Array.isArray(providers2) && providers2.some(p => (p.id === 'test-mem' || p.id === createdId))
    ok('POST 创建渠道 → 读回存在(内存写读)', r.status === 200 && found,
      `status=${r.status} 渠道数=${Array.isArray(providers2) ? providers2.length : 'N/A'}`)
  }

  // 7. 错误密码登录 → 401
  r = await call('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong' }),
  })
  ok('POST /admin/login 错误密码 → 401', r.status === 401, `status=${r.status}`)

  // 8. /v1/models 无 key → 401
  r = await call('/v1/models')
  ok('GET /v1/models 无 key → 401', r.status === 401, `status=${r.status}`)

  // 9. 404 路由
  r = await call('/nonexistent-xyz')
  ok('GET /nonexistent → 404', r.status === 404, `status=${r.status}`)

  console.log(results.join('\n'))
  const failed = results.filter(x => x.startsWith('❌')).length
  console.log(`\n结果: ${results.length - failed}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
}).catch(e => { console.error('FATAL:', e); process.exit(2) })