// src/cf-tls-client.ts — Cloudflare Pages Functions 原生单轨 TLS 1.3 客户端
//
// 存在理由：Cloudflare Workers 的高级 fetch() 出口 TLS 指纹被平台锁死，
// 无法满足 opencode.ai 免费池门禁3 对 17-cipher 列表（JA4 5b57614c22b0）的硬性校验。
// 本模块基于 cloudflare:sockets 的原始 TCP 套接字（secureTransport: 'off'），
// 配合纯 JS 驱动的 lemon-tls，自主在 Worker 内存中向 opencode.ai 下发完全吻合的 ClientHello，
// 零外部中继、零第三方服务器，在 Cloudflare 边缘实现 100% 独立自主出网。

import { Duplex } from 'node:stream'
import { Buffer } from 'node:buffer'
import lemonTls from 'lemon-tls'

export const OPENCODE_CIPHER_LIST = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-ECDSA-AES128-SHA',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-ECDSA-AES256-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
].join(':')

async function getConnectFunction() {
  const mod = await import('cloudflare:sockets')
  return mod.connect
}

function bridgeSocketToDuplex(rawSock: any): Duplex {
  const writer = rawSock.writable.getWriter()
  const reader = rawSock.readable.getReader()
  let writerClosed = false

  const duplex = new Duplex({
    read() {},
    async write(chunk, _encoding, callback) {
      try {
        if (!writerClosed) {
          const u8 = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk)
          await writer.write(u8)
        }
        callback()
      } catch (err: any) {
        callback(err)
      }
    },
    async final(callback) {
      try {
        writerClosed = true
        await writer.close()
        callback()
      } catch (err: any) {
        callback(err)
      }
    },
  })

  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          duplex.push(null)
          break
        }
        if (value) {
          duplex.push(Buffer.from(value))
        }
      }
    } catch (err) {
      duplex.destroy(err as any)
    }
  })()

  return duplex
}

function parseHttpResponse(tlsSocket: any): Promise<Response> {
  return new Promise((resolve, reject) => {
    let headerBuffer = Buffer.alloc(0)
    let headerParsed = false
    let statusCode = 200
    let statusText = 'OK'
    const responseHeaders = new Headers()
    let isChunked = false

    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    const responseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
      cancel() {
        tlsSocket.destroy()
      },
    })

    // 处理 chunked 编码的解码状态机
    let chunkState: 'size' | 'data' | 'crlf' = 'size'
    let chunkSize = 0
    let chunkBuffer = Buffer.alloc(0)

    function processBodyBytes(raw: Buffer) {
      if (!isChunked) {
        streamController?.enqueue(new Uint8Array(raw))
        return
      }

      chunkBuffer = Buffer.concat([chunkBuffer, raw])
      while (chunkBuffer.length > 0) {
        if (chunkState === 'size') {
          const crlfIdx = chunkBuffer.indexOf('\r\n')
          if (crlfIdx === -1) break
          const sizeLine = chunkBuffer.slice(0, crlfIdx).toString('ascii').trim()
          chunkSize = parseInt(sizeLine.split(';')[0], 16)
          chunkBuffer = chunkBuffer.slice(crlfIdx + 2)
          if (isNaN(chunkSize) || chunkSize === 0) {
            // chunk 传输结束
            try { streamController?.close() } catch {}
            tlsSocket.destroy()
            return
          }
          chunkState = 'data'
        }

        if (chunkState === 'data') {
          if (chunkBuffer.length < chunkSize) break
          const dataChunk = chunkBuffer.slice(0, chunkSize)
          streamController?.enqueue(new Uint8Array(dataChunk))
          chunkBuffer = chunkBuffer.slice(chunkSize)
          chunkState = 'crlf'
        }

        if (chunkState === 'crlf') {
          if (chunkBuffer.length < 2) break
          chunkBuffer = chunkBuffer.slice(2) // 剥离尾随 \r\n
          chunkState = 'size'
        }
      }
    }

    tlsSocket.on('data', (chunk: Buffer) => {
      if (!headerParsed) {
        headerBuffer = Buffer.concat([headerBuffer, chunk])
        const headerEnd = headerBuffer.indexOf('\r\n\r\n')
        if (headerEnd !== -1) {
          headerParsed = true
          const headerString = headerBuffer.slice(0, headerEnd).toString('utf-8')
          const remainingBody = headerBuffer.slice(headerEnd + 4)

          const lines = headerString.split('\r\n')
          const statusLine = lines[0] || 'HTTP/1.1 200 OK'
          const parts = statusLine.split(' ')
          statusCode = parseInt(parts[1] || '200', 10)
          statusText = parts.slice(2).join(' ') || 'OK'

          for (let i = 1; i < lines.length; i++) {
            const line = lines[i]
            const colon = line.indexOf(':')
            if (colon !== -1) {
              const k = line.slice(0, colon).trim().toLowerCase()
              const v = line.slice(colon + 1).trim()
              if (k !== 'content-length' && k !== 'content-encoding') {
                responseHeaders.set(k, v)
              }
            }
          }

          isChunked = (responseHeaders.get('transfer-encoding') || '').toLowerCase().includes('chunked')

          resolve(new Response(responseStream, {
            status: statusCode,
            statusText,
            headers: responseHeaders,
          }))

          if (remainingBody.length > 0) {
            processBodyBytes(remainingBody)
          }
        }
      } else {
        processBodyBytes(chunk)
      }
    })

    tlsSocket.on('end', () => {
      try { streamController?.close() } catch {}
    })

    tlsSocket.on('error', (err: any) => {
      if (!headerParsed) {
        reject(err)
      } else {
        try { streamController?.error(err) } catch {}
      }
    })
  })
}

/**
 * Cloudflare Pages 专属原生出网 fetch：
 * 通过 cloudflare:sockets 建立裸 TCP + 纯 JS TLSSocket 握手，下发指定 17-cipher 列表。
 */
export async function cfCustomTlsFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  const connectFn = await getConnectFunction()
  const url = new URL(rawUrl)
  const host = url.hostname
  const port = Number(url.port) || (url.protocol === 'http:' ? 80 : 443)

  const rawSock = connectFn({ hostname: host, port }, { secureTransport: 'off' })
  await rawSock.opened
  const duplex = bridgeSocketToDuplex(rawSock)

  const TLSSocket = (lemonTls as any).TLSSocket || (lemonTls as any).default?.TLSSocket
  const tlsSocket = new TLSSocket(duplex, {
    isServer: false,
    host,
    servername: host,
    ciphers: OPENCODE_CIPHER_LIST,
    rejectUnauthorized: false,
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('cloudflare:sockets TLS 握手超时 (15s)'))
    }, 15000)
    tlsSocket.once('secureConnect', () => {
      clearTimeout(timer)
      resolve()
    })
    tlsSocket.once('error', (err: any) => {
      clearTimeout(timer)
      reject(err)
    })
  })

  const method = (init.method || 'GET').toUpperCase()
  const path = url.pathname + url.search
  let headerText = `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n`

  if (init.headers) {
    const headers = new Headers(init.headers)
    headers.forEach((val, key) => {
      const lower = key.toLowerCase()
      if (lower !== 'host' && lower !== 'connection') {
        headerText += `${key}: ${val}\r\n`
      }
    })
  }

  let bodyBuf: Uint8Array | null = null
  if (init.body) {
    if (typeof init.body === 'string') {
      bodyBuf = new TextEncoder().encode(init.body)
    } else if (init.body instanceof Uint8Array) {
      bodyBuf = init.body
    } else if (init.body instanceof ArrayBuffer) {
      bodyBuf = new Uint8Array(init.body)
    }
  }

  if (bodyBuf && bodyBuf.length > 0) {
    headerText += `Content-Length: ${bodyBuf.length}\r\n`
  }
  headerText += '\r\n'

  tlsSocket.write(headerText)
  if (bodyBuf && bodyBuf.length > 0) {
    tlsSocket.write(bodyBuf)
  }

  return parseHttpResponse(tlsSocket)
}
