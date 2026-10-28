/**
 * 全量量化对比测试：ai-gateway (Cloudflare Pages) vs ai-gateway-intl (腾讯云 EdgeOne 新加坡纯海外节点)
 *
 * 两站均位于纯海外无墙环境，均使用原生直连（不经过任何中继）。
 */

import { ProxyAgent, setGlobalDispatcher } from 'undici'
// 本机测试通过本地代理访问（规避 MLC excluded 网关限制）
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:10808'))

const SITES = [
  {
    name: 'ai-gateway (Cloudflare Pages)',
    short: 'CF-Pages',
    baseUrl: 'https://api.seurl.eu.org',
  },
  {
    name: 'ai-gateway-intl (EdgeOne 新加坡纯海外)',
    short: 'EdgeOne-SG',
    baseUrl: 'https://ai-gateway-intl-zx4lt9nh.edgeone.dev',
  },
]

const ADMIN_KEY = process.env.ADMIN_PROXY_KEY || ''
const ADMIN_USER = process.env.ADMIN_USERNAME || ''
const ADMIN_PASS = process.env.ADMIN_PASSWORD || ''
const CALL_TIMEOUT_MS = 60000

const missingCredentials = [
  ['ADMIN_PROXY_KEY', ADMIN_KEY],
  ['ADMIN_USERNAME', ADMIN_USER],
  ['ADMIN_PASSWORD', ADMIN_PASS],
].filter(([, value]) => !value).map(([name]) => name)
if (missingCredentials.length) {
  throw new Error(`Set required environment variables: ${missingCredentials.join(', ')}`)
}

function createClient(site) {
  const cookies = {}

  function updateCookies(res) {
    const raw = res.headers.get('set-cookie')
    if (!raw) return
    for (const p of raw.split(/,(?=[^;]+?=)/)) {
      const pair = p.trim().split(';')[0]
      const eq = pair.indexOf('=')
      if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
    }
  }

  function cookieHeader() {
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async function login() {
    const res = await fetch(`${site.baseUrl}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader() },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
    })
    updateCookies(res)
    return res.status
  }

  async function api(path, options = {}) {
    const res = await fetch(`${site.baseUrl}${path}`, {
      ...options,
      headers: { Cookie: cookieHeader(), ...(options.headers || {}) },
    })
    updateCookies(res)
    return res
  }

  return { login, api, cookieHeader }
}

async function fetchSnapshot(site) {
  const client = createClient(site)
  const loginStatus = await client.login()

  const statusRes = await client.api('/admin/api/status')
  const statusData = await statusRes.json().catch(() => ({}))

  const provRes = await client.api('/admin/api/providers')
  const provData = await provRes.json().catch(() => ({}))

  const keysRes = await client.api('/admin/api/proxy-keys')
  const keysData = await keysRes.json().catch(() => ({}))

  return {
    loginStatus,
    status: statusData.data || null,
    providers: provData.data || [],
    proxyKeys: keysData.data || [],
  }
}

async function callModel(site, model, timeoutMs = CALL_TIMEOUT_MS) {
  const first = await callModelOnce(site, model, timeoutMs)
  if (first.ok && first.hasContent) return first
  const retriable = first.status === 429 || first.status === 0 || first.status >= 500
  if (!retriable) return first
  await new Promise(r => setTimeout(r, 2000))
  const second = await callModelOnce(site, model, timeoutMs)
  return second.ok && second.hasContent ? { ...second, retried: true } : first
}

async function callModelOnce(site, model, timeoutMs) {
  const client = createClient(site)
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${site.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '请用一句话回答：你好' }],
        max_tokens: 50,
        stream: false,
      }),
      signal: controller.signal,
    })
    const latencyMs = Date.now() - started
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { /* ignore */ }

    const content = parsed?.choices?.[0]?.message?.content
    const reasoning = parsed?.choices?.[0]?.message?.reasoning
    const usage = parsed?.usage

    return {
      model,
      ok: res.status === 200,
      status: res.status,
      latencyMs,
      hasContent: Boolean((content && content.trim()) || (reasoning && reasoning.trim())),
      contentPreview: (content || reasoning || '').replace(/\s+/g, ' ').slice(0, 60),
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      error: res.status === 200 ? null : (parsed?.error?.message || text.slice(0, 160)),
    }
  } catch (e) {
    return {
      model,
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      hasContent: false,
      contentPreview: '',
      promptTokens: 0,
      completionTokens: 0,
      error: e.name === 'AbortError' ? `超时 (>${timeoutMs}ms)` : e.message,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function pool(items, limit, worker) {
  const results = []
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      results[idx] = await worker(items[idx], idx)
    }
  })
  await Promise.all(runners)
  return results
}

function fmtPct(n, d) {
  if (!d) return '0.0%'
  return `${((n / d) * 100).toFixed(1)}%`
}

function median(arr) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

async function main() {
  const concurrency = Number(process.env.CONCURRENCY || 4)

  console.log('═'.repeat(80))
  console.log('  全量量化对比测试：Cloudflare Pages  vs  腾讯云 EdgeOne (新加坡纯海外)')
  console.log('═'.repeat(80))

  console.log('\n【阶段一】拉取两站配置快照...\n')
  const snapshots = {}
  for (const site of SITES) {
    process.stdout.write(`  → ${site.name} ... `)
    try {
      snapshots[site.short] = await fetchSnapshot(site)
      const s = snapshots[site.short]
      console.log(`OK (登录 ${s.loginStatus}, 渠道 ${s.status?.providersCount}, 启用模型 ${s.status?.enabledModelsCount}, 执行节点: ${s.status?.baseUrl?.split('.')[0]})`)
    } catch (e) {
      console.log(`失败: ${e.message}`)
      snapshots[site.short] = null
    }
  }

  // 待测模型列表
  const eoProv = new Map((snapshots['EdgeOne-SG']?.providers || []).map(p => [p.id, p]))
  const modelList = []
  for (const [id, p] of eoProv) {
    if (!p.enabled) continue
    for (const m of p.models || []) {
      if (!m.enabled) continue
      if (id === 'Azure' || id === 'agnes-video') continue
      if (/_image|image-|lyria|embedding/.test(m.id)) continue
      modelList.push({ provider: id, model: `${id}/${m.id}` })
    }
  }

  console.log(`\n【阶段二】待测对话模型总数: ${modelList.length} 个（两站使用相同模型清单逐项测试）`)

  const summary = {}
  for (const site of SITES) {
    console.log(`\n──────── ${site.name} ────────`)
    const t0 = Date.now()
    const results = await pool(modelList, concurrency, async (item, i) => {
      const r = await callModel(site, item.model)
      const flag = r.ok && r.hasContent ? '✓' : r.ok ? '~' : '✗'
      process.stdout.write(
        `  ${flag} [${String(i + 1).padStart(2)}/${modelList.length}] ${item.model.padEnd(46)} ` +
        `${String(r.status).padStart(3)} ${String(r.latencyMs).padStart(6)}ms ${r.ok ? (r.contentPreview || '').slice(0, 40) : (r.error || '').slice(0, 50)}\n`
      )
      return r
    })
    const elapsed = Date.now() - t0

    const okCount = results.filter(r => r.ok).length
    const contentCount = results.filter(r => r.ok && r.hasContent).length
    const latencies = results.filter(r => r.ok).map(r => r.latencyMs)

    summary[site.short] = {
      total: results.length,
      ok: okCount,
      withContent: contentCount,
      promptTokens: results.reduce((s, r) => s + r.promptTokens, 0),
      completionTokens: results.reduce((s, r) => s + r.completionTokens, 0),
      avgLatency: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      medianLatency: median(latencies),
      elapsedMs: elapsed,
      results,
    }
    console.log(`\n  ${site.short} 汇总: HTTP 200 = ${okCount}/${results.length} (${fmtPct(okCount, results.length)})，` +
      `有内容 = ${contentCount}，平均延迟 ${summary[site.short].avgLatency}ms，总耗时 ${(elapsed / 1000).toFixed(1)}s`)
  }

  console.log('\n' + '═'.repeat(80))
  console.log('  量化对比总表')
  console.log('═'.repeat(80) + '\n')

  const summaryRows = SITES.map(site => {
    const s = summary[site.short]
    return {
      '站点': site.name,
      '测试模型数': s.total,
      'HTTP 200 成功率': `${s.ok} (${fmtPct(s.ok, s.total)})`,
      '实际生成有效内容': `${s.withContent} (${fmtPct(s.withContent, s.total)})`,
      '输入Tokens': s.promptTokens,
      '输出Tokens': s.completionTokens,
      '平均延迟': `${s.avgLatency}ms`,
      '中位延迟': `${s.medianLatency}ms`,
      '总耗时': `${(s.elapsedMs / 1000).toFixed(1)}s`,
    }
  })
  console.table(summaryRows)

  // 对比两站不一致的项
  console.log('\n两站行为差异对比:\n')
  const cfResults = new Map((summary['CF-Pages']?.results || []).map(r => [r.model, r]))
  const eoResults = new Map((summary['EdgeOne-SG']?.results || []).map(r => [r.model, r]))
  let diffCount = 0
  const diffRows = []
  for (const { model } of modelList) {
    const a = cfResults.get(model)
    const b = eoResults.get(model)
    const aOk = a?.ok && a?.hasContent
    const bOk = b?.ok && b?.hasContent
    if (aOk !== bOk) {
      diffCount++
      diffRows.push({
        '模型': model,
        'CF-Pages': aOk ? '可用' : `失败(${a?.status})`,
        'EdgeOne-SG': bOk ? '可用' : `失败(${b?.status})`,
        'CF结果/错误': (aOk ? a?.contentPreview : a?.error || '').slice(0, 45),
        'EO结果/错误': (bOk ? b?.contentPreview : b?.error || '').slice(0, 45),
      })
    }
  }
  if (diffCount === 0) {
    console.log('  ✓ 两站在所有模型上的可用性完全一致！')
  } else {
    console.table(diffRows)
  }

  console.log('\n' + '═'.repeat(80))
  console.log('  对比测试完成')
  console.log('═'.repeat(80))
}

main().catch(e => { console.error('测试失败:', e); process.exit(1) })
