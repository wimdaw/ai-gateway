/**
 * 统一的响应 / 参数助手。
 *
 * 只做「写法收敛」，**不改变任何既有响应结构**，字段顺序也与旧实现一致：
 *   ok()        → { success: true, data?, message? }   （200 / 201 等）
 *   fail()      → { success: false, message, ...extra } （默认 400）
 *   apiError()  → { error: { message, type? } }         （404 / 500 / 诊断接口）
 *
 * 之所以单独抽一个文件：拆开的 routes / admin 模块都要用同一套写法，
 * 但谁都不该为了「统一」去改动已经和前端约定好的响应体。
 */
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiResponse } from './types'

/** 不关心具体 Bindings 的上下文别名：助手函数对所有 Env 通用 */
type AnyContext = Context<any>

/** 成功响应：{ success: true, data?, message? } */
export function ok<T>(
  c: AnyContext,
  data?: T,
  message?: string,
  status: ContentfulStatusCode = 200,
): Response {
  const body: ApiResponse<T> = { success: true }
  if (data !== undefined) body.data = data
  if (message !== undefined) body.message = message
  return c.json(body, status)
}

/**
 * 失败响应：{ success: false, message }。
 * extra 用于少数既有实现额外带的字段（例如 { data: 失败详情 }），保持字段顺序在其后。
 */
export function fail(
  c: AnyContext,
  message: string,
  status: ContentfulStatusCode = 400,
  extra?: Record<string, unknown>,
): Response {
  return c.json({ success: false, message, ...extra }, status)
}

/** 标准错误体：{ error: { message, type? } }；不传 type 时与旧实现一样只输出 message */
export function apiError(
  c: AnyContext,
  message: string,
  status: ContentfulStatusCode = 500,
  type?: string,
): Response {
  const error: { message: string; type?: string } = { message }
  if (type !== undefined) error.type = type
  return c.json({ error }, status)
}

/**
 * 取必填路径参数（如 /providers/:id 的 id）。
 *
 * 之前直接把 `c.req.param('id')` 交给要求 string 的函数，类型上是 string | undefined，
 * 一旦真的缺失就会把 undefined 传进去（或运行期崩溃）。这里统一兜底成 400：
 *
 *   const id = requireParam(c, 'id')
 *   if (id instanceof Response) return id   // 缺失时直接返回 400
 */
export function requireParam(c: AnyContext, name: string): string | Response {
  const value = c.req.param(name)
  if (!value) return fail(c, `缺少 ${name} 参数`, 400)
  return value
}
