// src/bun.ts — Koyeb 的 Bun 入口
//
// 必须用 Bun 而不是 Node 起服务：opencode.ai 免费池的门禁3 校验 TLS ClientHello
// 的 cipher 列表（JA4 cipher hash 5b57614c22b0），只有 Bun 的 BoringSSL 默认
// 17-cipher 能过；Node 的 OpenSSL 指纹（含 System 原生 fetch）一律 429。
// 这个进程同时承担 Pages / EdgeOne 的 /__opencode_relay 出网职责。
declare const Bun: any

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import app from './index'

const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:yxy.%40990524gdg@db.pusivmawucsmkspnoqrf.supabase.co:5432/postgres'

const sql = postgres(dbUrl, {
  prepare: false, // 禁用 prepared statements，兼容 Supabase Transaction/Session Pooler
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
})

const port = Number(process.env.PORT) || 8000

// ===== 静态资源：/assets/* 直接读 dist/assets（文件名带内容哈希，可长缓存） =====
const ASSETS_DIR = fileURLToPath(new URL('./assets/', import.meta.url))
const ASSET_MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
}

async function serveStaticAsset(pathname: string): Promise<Response | null> {
  if (!pathname.startsWith('/assets/')) return null
  const name = pathname.slice('/assets/'.length)
  if (!/^[\w.-]+$/.test(name) || name.includes('..')) {
    return new Response('Not found', { status: 404 })
  }
  const ext = name.slice(name.lastIndexOf('.'))
  try {
    const body = await readFile(ASSETS_DIR + name)
    return new Response(new Uint8Array(body), {
      headers: {
        'Content-Type': ASSET_MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

Bun.serve({
  port,
  fetch: async (req: Request) => {
    const { pathname } = new URL(req.url)
    const staticRes = await serveStaticAsset(pathname)
    if (staticRes) return staticRes
    const customEnv = {
      PG: sql,
      ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'yxy.@990524gdg',
      OPENCODE_MIRRORS_URL: process.env.OPENCODE_MIRRORS_URL,
      OPENCODE_RELAY_URL: process.env.OPENCODE_RELAY_URL,
      OPENCODE_RELAY_TOKEN: process.env.OPENCODE_RELAY_TOKEN,
      AG_CLIENT_ID: process.env.AG_CLIENT_ID,
      AG_CLIENT_SECRET: process.env.AG_CLIENT_SECRET,
    }
    return app.fetch(req, customEnv, undefined as any)
  },
})

console.log(`AI Gateway (Bun) 监听端口: ${port}`)