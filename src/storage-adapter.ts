/**
 * 存储适配层：适配腾讯云 EdgeOne Makers Blob 存储
 * 使用 @edgeone/pages-blob SDK 提供强一致性（consistency: "strong"）数据读写
 */

import { getStore } from '@edgeone/pages-blob'
import type { UsageRecord, UsageSummary } from './types'

export interface KVLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>
    cursor?: string
    list_complete: boolean
  }>
}

let cachedBlobStore: any = null

/**
 * 获取 EdgeOne Blob Store 单例
 * 严格遵照 IRON RULE：始终声明 consistency: "strong"
 */
export function getBlobStore(env?: any): any {
  if (cachedBlobStore) return cachedBlobStore
  try {
    cachedBlobStore = getStore({
      name: 'ai-gateway',
      consistency: 'strong',
    })
    return cachedBlobStore
  } catch (err: any) {
    // 兼容本地测试或外部调用
    const token = env?.EDGEONE_TOKEN_NEW || env?.EDGEONE_TOKEN || process.env.EDGEONE_TOKEN_NEW || process.env.EDGEONE_TOKEN
    if (token) {
      try {
        cachedBlobStore = getStore({
          name: 'ai-gateway',
          token,
          consistency: 'strong',
        })
        return cachedBlobStore
      } catch {
        // fallback below
      }
    }
    // 内存兜底，保证极速冷启动或单测不中断
    cachedBlobStore = createMemoryStore()
    return cachedBlobStore
  }
}

/** 内存兜底 Store（当不在 EdgeOne 运行环境且无凭据时使用） */
function createMemoryStore(): any {
  const map = new Map<string, any>()
  return {
    async get(key: string, _opts?: any) {
      return map.get(key) ?? null
    },
    async setJSON(key: string, val: any) {
      map.set(key, val)
    },
    async delete(key: string) {
      map.delete(key)
    },
    async list(opts?: any) {
      const prefix = opts?.prefix ?? ''
      const blobs: Array<{ key: string }> = []
      for (const k of map.keys()) {
        if (k.startsWith(prefix)) blobs.push({ key: k })
      }
      return { blobs }
    },
  }
}

/** 基于 EdgeOne Blob 实现的 KV 兼容接口 */
function blobKVImpl(store: any): KVLike {
  return {
    async get(key: string): Promise<string | null> {
      try {
        const blobKey = `kv/${encodeURIComponent(key)}.json`
        const item = await store.get(blobKey, { type: 'json', consistency: 'strong' })
        if (!item) return null
        if (item.expiresAt && item.expiresAt < Math.floor(Date.now() / 1000)) {
          await store.delete(blobKey).catch(() => {})
          return null
        }
        return typeof item.value === 'string' ? item.value : JSON.stringify(item.value)
      } catch (e: any) {
        console.error(`[BlobKV] get error for ${key}:`, e?.message)
        return null
      }
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      const blobKey = `kv/${encodeURIComponent(key)}.json`
      const expiresAt = options?.expirationTtl
        ? Math.floor(Date.now() / 1000) + options.expirationTtl
        : null
      await store.setJSON(blobKey, {
        key,
        value,
        expiresAt,
        updatedAt: Date.now(),
      })
    },
    async delete(key: string): Promise<void> {
      const blobKey = `kv/${encodeURIComponent(key)}.json`
      await store.delete(blobKey).catch(() => {})
    },
    async list(options?: { prefix?: string; cursor?: string }): Promise<{
      keys: Array<{ name: string }>
      cursor?: string
      list_complete: boolean
    }> {
      const prefix = options?.prefix ?? ''
      const blobPrefix = `kv/${encodeURIComponent(prefix)}`
      const res = await store.list({
        prefix: blobPrefix,
        cursor: options?.cursor,
        paginate: false,
        consistency: 'strong',
      })
      const keys: Array<{ name: string }> = []
      for (const b of res.blobs || []) {
        if (!b.key.startsWith('kv/') || !b.key.endsWith('.json')) continue
        const rawEncoded = b.key.slice(3, -5)
        try {
          const originalKey = decodeURIComponent(rawEncoded)
          keys.push({ name: originalKey })
        } catch {
          keys.push({ name: rawEncoded })
        }
      }
      return {
        keys,
        list_complete: !res.cursor,
        cursor: res.cursor,
      }
    },
  }
}

/** 获取 KV 兼容实例 */
export function getKV(env?: any): KVLike {
  const store = getBlobStore(env)
  return blobKVImpl(store)
}

/** 返回当前实际生效的存储类型 */
export function getStorageType(_env?: any): 'edgeone-blob' {
  return 'edgeone-blob'
}

/** 存储类型的中文展示名 */
export function storageTypeLabel(_env?: any): string {
  return 'EdgeOne Blob 数据库'
}

/** 写入单次用量记录并更新每日聚合 */
export async function addUsageRecordBlob(env: any, record: UsageRecord): Promise<void> {
  const store = getBlobStore(env)
  const date = record.ts.slice(0, 10)
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const recordKey = `usage/records/${date}/${id}.json`

  // 1. 写入详情记录
  await store.setJSON(recordKey, record).catch(() => {})

  // 2. 累加日聚合数据
  const dailyKey = `usage/daily/${date}.json`
  try {
    const cur = (await store.get(dailyKey, { type: 'json', consistency: 'strong' })) ?? {
      date,
      requests: 0,
      successRequests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalLatencyMs: 0,
      byModel: {},
      byProvider: {},
    }
    cur.requests += 1
    if (record.ok) cur.successRequests += 1
    cur.promptTokens += record.promptTokens || 0
    cur.completionTokens += record.completionTokens || 0
    cur.totalLatencyMs += record.latencyMs || 0

    const displayModel = (record.model || '').replace(/[:\/\-]free$/i, '') || record.model || 'unknown'
    cur.byModel[displayModel] = cur.byModel[displayModel] || { requests: 0, promptTokens: 0, completionTokens: 0 }
    cur.byModel[displayModel].requests += 1
    cur.byModel[displayModel].promptTokens += record.promptTokens || 0
    cur.byModel[displayModel].completionTokens += record.completionTokens || 0

    const provider = record.provider || 'unknown'
    cur.byProvider[provider] = cur.byProvider[provider] || { requests: 0, promptTokens: 0, completionTokens: 0 }
    cur.byProvider[provider].requests += 1
    cur.byProvider[provider].promptTokens += record.promptTokens || 0
    cur.byProvider[provider].completionTokens += record.completionTokens || 0

    await store.setJSON(dailyKey, cur)
  } catch (err: any) {
    console.warn('[Usage] Daily aggregation update failed:', err?.message)
  }
}

/** 聚合指定天数的用量统计 */
export async function getUsageSummaryBlob(env: any, days: number): Promise<UsageSummary> {
  const store = getBlobStore(env)
  const dates: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000)
    dates.push(d.toISOString().slice(0, 10))
  }

  // 并行获取每天的聚合数据
  const dailyResults = await Promise.all(
    dates.map(async (date) => {
      const dailyKey = `usage/daily/${date}.json`
      const data = await store.get(dailyKey, { type: 'json', consistency: 'strong' }).catch(() => null)
      return { date, data }
    })
  )

  let totalRequests = 0
  let successRequests = 0
  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  let totalLatencyMs = 0

  const byModelMap = new Map<string, { requests: number; promptTokens: number; completionTokens: number }>()
  const byProviderMap = new Map<string, { requests: number; promptTokens: number; completionTokens: number }>()
  const dailyArr: Array<{ date: string; requests: number; promptTokens: number; completionTokens: number }> = []

  for (const { date, data } of dailyResults) {
    if (!data) {
      dailyArr.push({ date, requests: 0, promptTokens: 0, completionTokens: 0 })
      continue
    }

    totalRequests += data.requests || 0
    successRequests += data.successRequests || 0
    totalPromptTokens += data.promptTokens || 0
    totalCompletionTokens += data.completionTokens || 0
    totalLatencyMs += data.totalLatencyMs || 0

    dailyArr.push({
      date,
      requests: data.requests || 0,
      promptTokens: data.promptTokens || 0,
      completionTokens: data.completionTokens || 0,
    })

    for (const [model, stats] of Object.entries<any>(data.byModel || {})) {
      const prev = byModelMap.get(model) || { requests: 0, promptTokens: 0, completionTokens: 0 }
      byModelMap.set(model, {
        requests: prev.requests + stats.requests,
        promptTokens: prev.promptTokens + stats.promptTokens,
        completionTokens: prev.completionTokens + stats.completionTokens,
      })
    }

    for (const [prov, stats] of Object.entries<any>(data.byProvider || {})) {
      const prev = byProviderMap.get(prov) || { requests: 0, promptTokens: 0, completionTokens: 0 }
      byProviderMap.set(prov, {
        requests: prev.requests + stats.requests,
        promptTokens: prev.promptTokens + stats.promptTokens,
        completionTokens: prev.completionTokens + stats.completionTokens,
      })
    }
  }

  const byModel = Array.from(byModelMap.entries())
    .map(([model, s]) => ({ model, ...s }))
    .sort((a, b) => b.requests - a.requests)

  const byProvider = Array.from(byProviderMap.entries())
    .map(([provider, s]) => ({ provider, ...s }))
    .sort((a, b) => b.requests - a.requests)

  const avgLatencyMs = totalRequests > 0 ? Math.round(totalLatencyMs / totalRequests) : 0

  return {
    days,
    totalRequests,
    successRequests,
    totalPromptTokens,
    totalCompletionTokens,
    avgLatencyMs,
    byModel,
    byProvider,
    daily: dailyArr,
  }
}
