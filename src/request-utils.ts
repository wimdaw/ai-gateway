import type { Context } from 'hono'

/** 判断是否为 EdgeOne 内部网关地址（云函数收到的 host 会被内部代理重写成该域名） */
function isInternalHost(host: string): boolean {
  return /qcloudteo\.com$|pages-scf-|pages-pro-/i.test(host)
}

/**
 * 还原用户实际访问的外部 origin。
 *
 * EdgeOne 云函数运行时会把请求 URL 与 host 头重写为内部网关地址
 * （如 pages-pro-xxx.pages-scf-sg-pro.qcloudteo.com），真实访问域名通过
 * `eo-pages-host` 头传递（实测），故优先读取；其次 x-forwarded-host，
 * 再次未重写的 host 头，最后回退请求 URL。
 */
export function getExternalOrigin(c: Context): string {
  const candidates = [
    c.req.header('eo-pages-host'),
    c.req.header('x-forwarded-host'),
    c.req.header('host'),
  ]
  for (const candidate of candidates) {
    const host = candidate?.split(',')[0].trim()
    if (host && !isInternalHost(host)) {
      return `https://${host}`
    }
  }

  try {
    return new URL(c.req.url).origin
  } catch {
    return 'https://localhost'
  }
}
