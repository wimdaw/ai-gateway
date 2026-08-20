// EdgeOne 入口 — 注入 KV 存储 + 调用原 app
// 注意: 不在此文件导出 onRequest, 由打包脚本统一追加声明式导出
import app from './index'
import { createBlobKv } from './blob-kv'

// 内存兜底 (Blob 不可用时)
const mem = new Map()
const memoryKv = {
  async get(key: string) {
    const v = mem.get(key)
    return v === undefined ? null : v
  },
  async put(key: string, value: string) {
    mem.set(key, value)
  },
  async delete(key: string) {
    mem.delete(key)
  },
  async list() {
    return { keys: Array.from(mem.keys()).map((k) => ({ key: k })) }
  },
}

// 单例 KV: Blob 优先, 失败降级内存
let _kv: any = null
function getKV() {
  if (_kv) return _kv
  try {
    const blob = createBlobKv()
    // 探测 Blob 是否可用
    _kv = {
      async get(key: string) {
        // Blob 优先(最终一致性由上层重试覆盖), 内存仅在 Blob 不可用时兜底
        // 注意: 不能把 Blob 读到的旧值回填内存, 否则内存陈旧缓存会掩盖新写入
        try {
          const v = await blob.get(key);
          if (v !== null && v !== undefined) return v;
        } catch { /* Blob 不可用, 走内存 */ }
        return await memoryKv.get(key);
      },
      async put(key: string, value: string) {
        // 写穿: Blob + 内存都写
        await memoryKv.put(key, value);
        try { await blob.put(key, value) } catch { /* Blob 不可用则仅内存 */ }
      },
      async delete(key: string) {
        await memoryKv.delete(key);
        try { await blob.delete(key) } catch { /* ignore */ }
      },
      async list(opts?: any) {
        try { return await blob.list(opts) } catch { return await memoryKv.list() }
      },
    }
  } catch {
    _kv = memoryKv
  }
  return _kv
}

export async function __eoEntry(context: any) {
  const env = { ...(context.env || {}), KV: getKV() }
  return app.fetch(context.request, env)
}