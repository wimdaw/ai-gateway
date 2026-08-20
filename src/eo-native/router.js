// EdgeOne 原生路由 — 无框架依赖
export function parseUrl(request) {
  const url = new URL(request.url);
  return { path: url.pathname, url, method: request.method.toUpperCase() };
}

export async function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export async function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

export function matchPath(pattern, path) {
  // pattern: '/', '/v1/models', '/v1/*', '/admin/*', '/admin/api/providers/:id'
  if (pattern === '*') return { matched: true, params: {} };
  if (pattern === path) return { matched: true, params: {} };

  const pParts = pattern.split('/').filter(Boolean);
  const sParts = path.split('/').filter(Boolean);
  if (pParts[pParts.length - 1] === '*') {
    const prefix = pParts.slice(0, -1).join('/');
    if (path.startsWith('/' + prefix + (prefix ? '/' : '')) || (prefix === '' && path)) {
      return { matched: true, params: {} };
    }
    return { matched: false, params: {} };
  }
  if (pParts.length !== sParts.length) return { matched: false, params: {} };
  const params = {};
  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i].startsWith(':')) {
      params[pParts[i].slice(1)] = decodeURIComponent(sParts[i]);
    } else if (pParts[i] !== sParts[i]) {
      return { matched: false, params: {} };
    }
  }
  return { matched: true, params };
}

export function getCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

export function setCookieHeader(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.maxAge) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join('; ');
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function sha256Hex(text) {
  // Web Crypto 同步包装变体: 通过异步调用
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then((buf) => {
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  });
}