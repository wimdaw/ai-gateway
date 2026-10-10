/**
 * CodeBuddy 每日签到：批量签到、定时入口（专用令牌 + 当日节流）。
 */
import { Context } from 'hono'
// 注意：runCodebuddyCheckinAll 内有一个业务局部变量叫 ok（签到成功数），
// 这里把响应助手别名导入，避免遮蔽导致的阅读歧义（业务变量保持原名不动）。
import { ok as okJson, fail } from '../http'
import { getProviders, getProvider } from '../storage'
import { getKV } from '../storage-adapter'
import { checkinCodebuddy, codebuddyCronToken } from '../codebuddy'
import type { Env, ApiResponse } from '../types'
import { normalizeRegion } from './common'

/** 常量时间字符串比较，避免用 `===` 比较令牌时泄露长度/前缀信息。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ===== 定时签到的当日节流状态 =====

/** 定时签到状态在 KV 里的键（记录最近一次真正执行的结果，供节流与外部监控读取） */
const CRON_CHECKIN_STATE_KEY = 'cron:checkin:state'
/** 上次执行有失败时，多久之后才允许重试（避免外部监控高频 ping 打爆上游） */
const CRON_CHECKIN_RETRY_COOLDOWN_MS = 30 * 60 * 1000

interface CbCronState {
  /** 最近一次执行签到的日期（东八区，YYYY-MM-DD） */
  date: string
  /** 最近一次执行的 ISO 时间戳 */
  at: string
  total: number
  ok: number
  already: number
  failed: number
}

/**
 * 取东八区日期串。
 * 用东八区而不是 UTC，避免「北京凌晨 0–8 点」这段被算成前一天，导致漏签或重复签。
 */
function shanghaiDate(d: Date = new Date()): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

async function readCronState(env: Env): Promise<CbCronState | null> {
  try {
    const raw = await getKV(env).get(CRON_CHECKIN_STATE_KEY)
    return raw ? (JSON.parse(raw) as CbCronState) : null
  } catch {
    return null
  }
}

async function writeCronState(env: Env, state: CbCronState): Promise<void> {
  try {
    await getKV(env).put(CRON_CHECKIN_STATE_KEY, JSON.stringify(state))
  } catch {
    /* 状态写失败不影响签到结论 */
  }
}

export interface CbCheckinSummary {
  total: number
  ok: number
  already: number
  failed: number
  results: Array<Record<string, unknown>>
}

/**
 * 批量签到：遍历**所有** type=codebuddy 渠道的**全部启用凭据**，逐账号签到。
 * 账号之间间隔 200ms，避免对上游造成瞬时压力。「今日已签到」计入 already 而非 failed。
 * 后台批量与定时任务共用这一份实现。
 */
export async function runCodebuddyCheckinAll(env: Env): Promise<CbCheckinSummary> {
  const providers = (await getProviders(env)).filter((p) => p.type === 'codebuddy')
  const results: Array<Record<string, unknown>> = []
  let ok = 0
  let already = 0
  let failed = 0
  let done = 0
  for (const p of providers) {
    const keys = p.apiKeys.filter((k) => k.enabled && (k.key || '').trim())
    for (let i = 0; i < keys.length; i++) {
      if (done > 0) await new Promise((res) => setTimeout(res, 200))
      const r = await checkinCodebuddy(env, keys[i].key.trim(), p.baseUrl, p.region)
      done++
      if (r.ok) {
        if (r.already) already++
        else ok++
      } else {
        failed++
      }
      results.push({
        providerId: p.id,
        providerName: p.name,
        index: i,
        ok: r.ok,
        already: !!r.already,
        message: r.message,
        realm: r.realm,
        nickname: r.nickname,
        remain: r.remain,
      })
    }
  }
  return { total: results.length, ok, already, failed, results }
}

/**
 * 定时签到入口（`GET|POST /cron/checkin`）。
 *
 * 鉴权：不走管理员会话，改用由 `ADMIN_PASSWORD` 单向派生的**专用令牌**
 * （`X-Cron-Token` 头，或 `?token=`）。权限最小化：令牌只能触发签到，拿不到任何渠道配置。
 * 未配置 ADMIN_PASSWORD 时**失败关闭**（503）。
 *
 * 之所以同时支持 GET：外部存活监控（UptimeRobot / BetterStack 之类）通常只能配一个 URL，
 * 让它顺手把签到也触发了，就不必额外维护一套定时器。
 *
 * **当日节流**（关键）：监控可能几分钟 ping 一次，绝不能每次都真签到。规则：
 *  - 当天已**全部成功** → 直接跳过，不再打上游；
 *  - 当天有失败 → 允许重试，但距上次尝试不足 30 分钟则跳过（避免打爆上游）；
 *  - 还没有任何 CodeBuddy 渠道（total=0）→ 不落状态，每次都很轻量。
 *
 * 查询参数：
 *  - `token=`  令牌（等价于 `X-Cron-Token` 头）
 *  - `status=1` 只回报状态、不触发签到（人工/监控查看用）
 *  - `force=1`  忽略当日节流，强制执行一次
 */
export async function handleCronCheckin(c: Context<{ Bindings: Env }>) {
  const expected = await codebuddyCronToken(c.env)
  if (!expected) {
    return fail(c, '网关未配置 ADMIN_PASSWORD，定时签到不可用', 503)
  }
  const body = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }))
  const provided = (c.req.header('X-Cron-Token') || c.req.query('token') || body.token || '').trim()
  if (!provided || !timingSafeEqual(provided, expected)) {
    return fail(c, '令牌无效', 401)
  }

  const today = shanghaiDate()
  const prev = await readCronState(c.env)

  // 只回报状态，不触发
  if (c.req.query('status') === '1') {
    return okJson(c, { action: 'status', date: today, last: prev }, prev
        ? `最近一次签到：${prev.date}（共 ${prev.total} 个账号，新签到 ${prev.ok}、已签到 ${prev.already}、失败 ${prev.failed}）`
        : '还没有执行过签到')
  }

  const force = c.req.query('force') === '1'
  if (!force && prev && prev.date === today) {
    const cooling = prev.failed > 0 && Date.now() - Date.parse(prev.at) < CRON_CHECKIN_RETRY_COOLDOWN_MS
    if (prev.failed === 0 || cooling) {
      return okJson(c, { action: 'skipped', ...prev, date: today, results: [] }, prev.failed === 0
          ? `今日（${today}）已签到，跳过。共 ${prev.total} 个账号：新签到 ${prev.ok}、已签到 ${prev.already}`
          : `今日已尝试过且刚失败过，${Math.ceil(CRON_CHECKIN_RETRY_COOLDOWN_MS / 60000)} 分钟内不再重试`)
    }
  }

  const data = await runCodebuddyCheckinAll(c.env)
  // 没有任何渠道时不落状态：保持轻量，等用户配好渠道后自然生效
  if (data.total > 0) {
    await writeCronState(c.env, {
      date: today, at: new Date().toISOString(),
      total: data.total, ok: data.ok, already: data.already, failed: data.failed,
    })
  }
  return okJson(c, { action: 'checkin', date: today, ...data }, data.total === 0
      ? '没有已配置的 CodeBuddy 渠道（跳过）'
      : `共 ${data.total} 个账号：新签到 ${data.ok}、已签到 ${data.already}、失败 ${data.failed}`)
}

/**
 * CodeBuddy 每日签到。
 *  - 单账号：传 `refreshToken`（或 `providerId` + `index`），语义同 /status。
 *  - 批量：传 `all:true`，遍历所有 type=codebuddy 渠道的**全部启用凭据**。
 * 「今日已签到」计入 already 而非 failed。
 */
export async function handleCodebuddyCheckin(c: Context<{ Bindings: Env }>) {
  type CbCheckinBody = { refreshToken?: string; providerId?: string; baseUrl?: string; region?: string; index?: number; all?: boolean }
  const body = await c.req.json<CbCheckinBody>().catch(() => ({} as CbCheckinBody))

  // ===== 批量模式 =====
  if (body.all) {
    const data = await runCodebuddyCheckinAll(c.env)
    return okJson(c, data, data.total === 0
        ? '没有已配置的 CodeBuddy 渠道（跳过）'
        : `共 ${data.total} 个账号：新签到 ${data.ok}、已签到 ${data.already}、失败 ${data.failed}`)
  }

  // ===== 单账号模式 =====
  let refreshToken = (body.refreshToken || '').trim()
  let baseUrl = body.baseUrl || ''
  let region = normalizeRegion(body.region)
  if (!refreshToken && body.providerId) {
    const provider = await getProvider(c.env, body.providerId)
    if (!provider) return fail(c, `渠道 "${body.providerId}" 不存在`, 404)
    const keys = provider.apiKeys.filter((k) => k.enabled)
    const idx = Number.isInteger(body.index) ? (body.index as number) : 0
    refreshToken = (keys[idx]?.key || '').trim()
    baseUrl = baseUrl || provider.baseUrl
    region = region || provider.region
  }
  if (!refreshToken) {
    return fail(c, '请先填写 refresh_token，或先保存渠道再签到', 400)
  }
  const r = await checkinCodebuddy(c.env, refreshToken, baseUrl, region)
  return c.json<ApiResponse<typeof r>>({ success: r.ok, data: r, message: r.message })
}

