/**
 * 请求引导中间件：D1 建表 + 首次填充种子数据。
 *
 * 原实现在**每个请求**都会走一遍 ensureD1Tables（虽然内部有 early-return），
 * 这里改成 isolate 级 promise 缓存：
 *   - 冷启动后只真正执行一次，后续请求直接复用同一个 promise；
 *   - 并发到达的请求共享同一次初始化，不会重复建表 / 重复播种；
 *   - **失败时清空缓存**，下一次请求会重试（不允许一次失败把 isolate 永久卡死）；
 *   - 缓存只存活在当前 isolate 内存里，与原先的模块级 seeded 标志语义一致，不跨请求泄漏数据。
 */
import type { Context, Next } from 'hono'
import type { Env } from '../types'
import { ensureD1Tables } from '../storage-adapter'
import { seedInitialData } from '../storage'

let bootstrapPromise: Promise<void> | null = null

/** 执行（或复用）一次引导；失败会重置缓存，便于下次请求重试 */
export function ensureBootstrap(env: Env): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      if (env.DB) {
        await ensureD1Tables(env.DB)
      }
      await seedInitialData(env)
    })().catch((err) => {
      bootstrapPromise = null
      throw err
    })
  }
  return bootstrapPromise
}

/** Hono 中间件：引导完成后再继续（抛错时交由 app.onError 统一处理） */
export async function bootstrapMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  await ensureBootstrap(c.env)
  return next()
}
