#!/usr/bin/env node
// 部署后必测: 站点检查 + 登录 + 云函数单请求时长阶梯实测
// 用法: node scripts/verify-deploy.mjs [--base=https://api.own.cloudns.nz] [--full]
//   --base  目标站点（默认 EdgeOne 海外生产域名）
//   --full  额外探测超过 maxDuration 的 125s（预期失败，用于确认平台上限）
const args = process.argv.slice(2)
const getArg = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const FULL = args.includes('--full')
const BASE = (getArg('base', 'https://api.own.cloudns.nz')).replace(/\/$/, '')
const ADMIN = { username: process.env.ADMIN_USERNAME || '', password: process.env.ADMIN_PASSWORD || '' }

let pass = 0, fail = 0
const ok = (name, extra = '') => { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`) }
const ng = (name, extra = '') => { fail++; console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`) }
const chk = (name, cond, extra = '') => cond ? ok(name, extra) : ng(name, extra)

async function req(path, opt = {}, timeoutMs = 30000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(BASE + path, { ...opt, signal: ctrl.signal, redirect: 'manual' })
    const body = await r.text()
    return { status: r.status, body, headers: r.headers }
  } catch (e) {
    return { status: 0, body: String(e.message || e), headers: new Headers() }
  } finally { clearTimeout(t) }
}

console.log(`\n===== 部署后验证: ${BASE} =====\n`)

// ── 1. 站点基础检查 ──
console.log('— 站点检查 —')
let r = await req('/')
chk('首页 200', r.status === 200, `HTTP ${r.status}`)
chk('首页品牌大写 AI GATEWAY', r.body.includes('AI GATEWAY'))
chk('新版地址盒 endpoint-box--url', r.body.includes('endpoint-box--url'))
chk('平台标识 EdgeOne · Blob', r.body.includes('EdgeOne · Blob'))

r = await req('/admin/login')
chk('登录页含密码切换', r.status === 200 && r.body.includes('password-toggle'))

r = await req('/admin')
chk('未登录 /admin 重定向', [301, 302, 303, 307].includes(r.status), `HTTP ${r.status}`)

if (!ADMIN.username || !ADMIN.password) {
  console.log('\n跳过管理员与耗时探测：设置 ADMIN_USERNAME 和 ADMIN_PASSWORD 后可执行受保护路由验证。')
} else {
  // ── 2. 登录与后台 ──
  console.log('\n— 登录与后台 —')
  const jar = []
  r = await req('/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) })
  chk('登录成功', (() => { try { return JSON.parse(r.body).success === true } catch { return false } })())
  for (const line of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) jar.push(line.split(';')[0])
  const cookie = jar.join('; ')
  const auth = cookie ? { headers: { cookie } } : {}

  r = await req('/admin', auth)
  chk('后台含保存配置按钮', r.body.includes('telegramSave'))
  chk('后台含单行导航结构', r.body.includes('admin-topbar__nav'))
  chk('后台含 PC 侧栏', r.body.includes('admin-rail'))

  r = await req('/admin/api/telegram/save', { ...auth, method: 'POST', headers: { ...(auth.headers || {}), 'Content-Type': 'application/json' }, body: '{}' })
  chk('telegram/save 接口', r.body.includes('请填写'), r.body.slice(0, 60))
  r = await req('/admin/api/usage?days=1', auth)
  chk('用量接口', (() => { try { return JSON.parse(r.body).success === true } catch { return false } })())
  r = await req('/admin/api/providers', auth)
  chk('渠道接口', (() => { try { return JSON.parse(r.body).success === true } catch { return false } })())

  // ── 3. 云函数单请求时长阶梯实测（maxDuration: 120s） ──
  console.log('\n— 云函数单请求时长实测 —')
  const probe = await req('/admin/api/selftest/delay?ms=10', auth, 15000)
  if (probe.status !== 200) {
    console.log('  ⚠️ 该站点无 selftest/delay 端点，跳过时长实测（仅 EdgeOne 部署包含）')
  } else {
    const ladder = FULL ? [1000, 30000, 65000, 110000, 120000, 125000] : [1000, 30000, 65000, 110000, 120000]
    let maxOk = 0
    for (const ms of ladder) {
      const s = Date.now()
      const res = await req(`/admin/api/selftest/delay?ms=${ms}`, auth, ms + 30000)
      const wall = Date.now() - s
      let actual = -1
      try { actual = JSON.parse(res.body).data.actualMs } catch {}
      const okReq = res.status === 200 && actual >= ms * 0.9
      if (okReq) maxOk = Math.max(maxOk, ms)
      console.log(`  ${okReq ? '✅' : '❌'} 请求 ${String(Math.round(ms / 1000)).padStart(3)}s → HTTP ${res.status} 实际等待 ${(actual / 1000).toFixed(1)}s (墙钟 ${(wall / 1000).toFixed(1)}s)`)
    }
    console.log(`\n  ⏱  单请求实测最长成功: ${(maxOk / 1000).toFixed(0)}s${maxOk >= 120000 ? '（平台 120s 上限内完整可用）' : ''}`)
  }
}

console.log(`\n===== 结果: 通过 ${pass} 失败 ${fail} =====`)
process.exit(fail ? 1 : 0)
