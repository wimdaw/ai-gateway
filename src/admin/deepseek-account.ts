/**
 * DeepSeek 账号托管（网关代登录换 userToken）。
 */
import { Context } from 'hono'
import { ok, fail } from '../http'
import { getProvider, updateProvider } from '../storage'
import { encryptSecret, decryptSecret } from '../deepseek-account'
import { loginWithPassword } from '../deepseek-login'
import type { Env, Provider } from '../types'
import { redactProvider } from './common'

// ===== DeepSeek 账号托管（方案 B：网关代登录） =====

/**
 * 保存/更新某个 deepseek 渠道的账号信息。
 * body: { email?, mobile?, areaCode?, password? } —— password 明文进、密文存。
 * 传空字符串的 password 表示**清除已存密码**。
 */
export async function handleSaveDsAccount(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return fail(c, '缺少 id 参数', 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return fail(c, '渠道不存在', 404)
  if (provider.type !== 'deepseek') {
    return fail(c, '仅 DeepSeek 渠道支持账号托管', 400)
  }

  const body: any = await c.req.json().catch(() => null)
  if (!body) return fail(c, '请求体需为 JSON', 400)

  const prev = provider.dsAccount || {}
  const next: NonNullable<Provider['dsAccount']> = { ...prev }
  if (body.email !== undefined) next.email = String(body.email || '').trim() || undefined
  if (body.mobile !== undefined) next.mobile = String(body.mobile || '').trim() || undefined
  if (body.areaCode !== undefined) next.areaCode = String(body.areaCode || '').trim() || undefined

  if (body.password !== undefined) {
    const plain = String(body.password || '')
    if (!plain) {
      // 显式清除
      delete next.passwordEnc
    } else {
      const enc = await encryptSecret(c.env, plain)
      if (!enc) {
        return fail(c, '密码加密失败：网关未配置 ADMIN_PASSWORD，或加密不可用', 503)
      }
      next.passwordEnc = enc
    }
  }

  if (!next.email && !next.mobile) {
    return fail(c, '需要填写邮箱或手机号之一', 400)
  }

  const updated = await updateProvider(c.env, id, { dsAccount: next })
  // updateProvider 在渠道被并发删除时会返回 null，这里兜底 404，避免脱敏函数解引用空值
  if (!updated) return fail(c, '渠道不存在', 404)
  return ok(c, redactProvider(updated), '账号已保存（密码加密存储）')
}

/**
 * 用已存（或本次传入）的账号密码**代登录**，换取 userToken 并写回渠道。
 *
 * 安全约束：
 *   - 只允许 type=deepseek 的渠道；
 *   - 不返回密码/密文，只返回登录结果摘要；
 *   - 登录成功会把 userToken 写回 dsAccount.userToken（方便「已托管」状态可见）。
 *
 * body 可选：{ email?, mobile?, areaCode?, password? } —— 传了就用传的（先存后登），
 * 不传就用库里已存的密文解密后登录。
 */
export async function handleDsLogin(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return fail(c, '缺少 id 参数', 400)
  const provider = await getProvider(c.env, id)
  if (!provider) return fail(c, '渠道不存在', 404)
  if (provider.type !== 'deepseek') {
    return fail(c, '仅 DeepSeek 渠道支持代登录', 400)
  }

  const body: any = await c.req.json().catch(() => ({}))
  const saved = provider.dsAccount || {}

  const email = (body?.email !== undefined ? String(body.email || '') : saved.email || '').trim() || undefined
  const mobile = (body?.mobile !== undefined ? String(body.mobile || '') : saved.mobile || '').trim() || undefined
  const areaCode = (body?.areaCode !== undefined ? String(body.areaCode || '') : saved.areaCode || '').trim() || undefined

  let password = ''
  if (body?.password) {
    password = String(body.password)
  } else if (saved.passwordEnc) {
    const dec = await decryptSecret(c.env, saved.passwordEnc)
    if (!dec) {
      return fail(c, '已存密码无法解密（可能改过 ADMIN_PASSWORD）。请重新填写密码后重试。', 409)
    }
    password = dec
  }
  if (!password) {
    return fail(c, '没有可用密码：请先填写账号密码', 400)
  }
  if (!email && !mobile) {
    return fail(c, '需要填写邮箱或手机号之一', 400)
  }

  const result = await loginWithPassword({ email, mobile, password, areaCode })

  // 写回结果（无论成败都记时间线；成功才存 token）
  const next: NonNullable<Provider['dsAccount']> = {
    ...saved,
    email,
    mobile,
    areaCode,
    lastLoginAt: new Date().toISOString(),
    lastLoginResult: result.ok ? 'ok' : result.msg || result.error || '登录失败',
    lastRotated: result.rotated,
  }
  if (result.ok && result.userToken) next.userToken = result.userToken
  // 若本次是带明文密码登录，顺手把密码也存下来（下次免输）
  if (body?.password && password) {
    const enc = await encryptSecret(c.env, password)
    if (enc) next.passwordEnc = enc
  }
  await updateProvider(c.env, id, { dsAccount: next })

  if (!result.ok) {
    return fail(c, result.msg || result.error || '登录失败', 200, { data: result })
  }
  // 登录后重读渠道做脱敏返回；渠道被并发删除时兜底 404，避免非空断言在运行期崩溃
  const refreshed = await getProvider(c.env, id)
  if (!refreshed) return fail(c, '渠道不存在', 404)
  return ok(c, redactProvider(refreshed), result.muted
      ? '登录成功，但该账号当前处于禁言/受限状态'
      : result.rotated
        ? '登录成功，已按服务端要求轮换令牌'
        : '登录成功，userToken 已保存')
}

/** 清除某个渠道托管的账号（含密文与 token） */
export async function handleClearDsAccount(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id')
  if (!id) return fail(c, '缺少 id 参数', 400)
  const updated = await updateProvider(c.env, id, { dsAccount: undefined })
  if (!updated) return fail(c, '渠道不存在', 404)
  return ok(c, redactProvider(updated), '已清除托管账号')
}

