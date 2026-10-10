// scripts/verify.mjs — 本地冒烟验证：不需要 Cloudflare 账号，也不需要 wrangler
// 用法：node scripts/build.mjs && node scripts/verify.mjs
import { readFileSync, existsSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const workerPath = join(dist, '_worker.js')

if (!existsSync(workerPath)) {
  console.error('缺少 dist/_worker.js，请先执行：node scripts/build.mjs')
  process.exit(1)
}

// ── 1) 客户端脚本语法 ─────────────────────────────────────────────────────
// 客户端脚本是被内联进 HTML 的模板字符串，语法错误只会在浏览器里炸；
// 这里先用 esbuild 求值成真实字符串，再用 vm 解析，提前拦下来。
const esbuild = await import('file:///' + join(root, 'node_modules', 'esbuild', 'lib', 'main.js').replace(/\\/g, '/'))
const scriptSrc = readFileSync(join(root, 'src', 'admin.script.ts'), 'utf8')
const transformed = await esbuild.transform(scriptSrc, { loader: 'ts', format: 'esm' })
const tmpDir = mkdtempSync(join(tmpdir(), 'ai-gateway-verify-'))
const tmpFile = join(tmpDir, 'admin-script.mjs')
writeFileSync(tmpFile, transformed.code)
const mod = await import('file:///' + tmpFile.replace(/\\/g, '/'))
const clientScript = mod.ADMIN_CLIENT_SCRIPT

const failures = []
function check(name, fn) {
  try { fn(); console.log(  '✅ ' + name) }
  catch (e) { failures.push(name + ' -> ' + e.message); console.log('  ❌ ' + name + ' -> ' + e.message) }
}

console.log('客户端脚本')
await check('语法可解析 (' + clientScript.split('\n').length + ' 行)', () => new vm.Script(clientScript, { filename: 'admin-client.js' }))
await check('不含未声明的响应对象引用', () => {
  const bad = clientScript.split('\n').filter((l) => /\br\.(json|blob)\b/.test(l))
  if (bad.length) throw new Error(bad[0].trim().slice(0, 80))
})

// ── 2) 路由冒烟 ───────────────────────────────────────────────────────────
// 最小 D1 桩：只保证渲染路径能跑通，不校验 SQL 语义
const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [], success: true, meta: {} }), run: async () => ({ success: true, results: [], meta: {} }), raw: async () => [] }
const DB = { prepare: () => stmt, exec: async () => ({ count: 0 }), batch: async (list) => list.map(() => ({ success: true, results: [] })), dump: async () => new ArrayBuffer(0) }
const env = { DB, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'verify-pass' }

const { default: app } = await import('file:///' + workerPath.replace(/\\/g, '/') + '?t=' + Date.now())

const cases = [
  ['GET', '/', 200, ['home-hero', '/assets/app.']],
  ['GET', '/admin/login', 200, ['/assets/app.']],
  ['GET', '/admin', 302, []],
  ['GET', '/admin/api/status', 401, []],
  ['GET', '/v1/models', 401, []],
  ['GET', '/v1/files', 401, []],
  ['GET', '/nope', 404, []],
]

console.log('')
console.log('路由冒烟')
const originalError = console.error
console.error = () => {}
for (const [method, path, want, markers] of cases) {
  let res, text = ''
  try {
    res = await app.request(path, { method }, env)
    text = await res.text()
  } catch (e) {
    console.error = originalError
    failures.push(method + ' ' + path + ' 抛异常: ' + e.message)
    console.log('  ❌ ' + method + ' ' + path + ' -> ' + e.message)
    console.error = () => {}
    continue
  }
  const missing = markers.filter((m) => !text.includes(m))
  const good = res.status === want && missing.length === 0
  console.log((good ? '  ✅ ' : '  ❌ ') + method + ' ' + path + ' -> ' + res.status + ' (期望 ' + want + ')' + (missing.length ? ' 缺少: ' + missing.join(',') : ''))
  if (!good) failures.push(method + ' ' + path)
}
console.error = originalError

// ── 3) 构建产物 ───────────────────────────────────────────────────────────
console.log('')
console.log('构建产物')
await check('_routes.json 无 BOM', () => {
  const first = readFileSync(join(dist, '_routes.json'))
  if (first[0] === 0xef && first[1] === 0xbb && first[2] === 0xbf) throw new Error('存在 UTF-8 BOM')
})
await check('index.html 已就位', () => { if (!existsSync(join(dist, 'index.html'))) throw new Error('缺失') })
await check('静态资源目录存在且非空', () => {
  const dir = join(dist, 'assets')
  if (!existsSync(dir)) throw new Error('缺少 dist/assets')
  const files = readdirSync(dir)
  if (!files.some((f) => f.startsWith('app.') && f.endsWith('.css'))) throw new Error('缺少 CSS 资源')
  if (!files.some((f) => f.startsWith('admin.') && f.endsWith('.js'))) throw new Error('缺少管理端脚本')
  if (!files.some((f) => f.startsWith('shared.') && f.endsWith('.js'))) throw new Error('缺少共享脚本')
})
await check('_headers 声明了资源长缓存', () => {
  const h = readFileSync(join(dist, '_headers'), 'utf8')
  if (!/\/assets\/\*/.test(h) || !/immutable/.test(h)) throw new Error('_headers 内容不完整')
})
await check('_routes.json 已排除 /assets/*', () => {
  const r = JSON.parse(readFileSync(join(dist, '_routes.json'), 'utf8'))
  if (!Array.isArray(r.exclude) || !r.exclude.includes('/assets/*')) throw new Error('未排除 /assets/*')
})
await check('页面不内联 CSS（渲染产物）', async () => {
  for (const p of ['/', '/admin/login']) {
    const res = await app.request(p, { method: 'GET' }, env)
    const html = await res.text()
    if (/<style>/.test(html)) throw new Error(p + ' 仍含内联 style')
    if (!/\/assets\/app\.[0-9a-f]+\.css/.test(html)) throw new Error(p + ' 未引用外链 CSS')
  }
})

console.log('')
if (failures.length) {
  console.log('验证失败 ' + failures.length + ' 项:')
  failures.forEach((f) => console.log('  - ' + f))
  process.exit(1)
}
console.log('全部验证通过')
