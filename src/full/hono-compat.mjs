/**
 * Hono 兼容层 — EdgeOne 原生实现
 * 实现原项目用到的 Hono API 子集:
 *   Hono: get/post/put/patch/delete/all/use/notFound/onError/fetch
 *   Context: req.url/method/header/json/param/query, json/html/redirect, env, set/get
 *   cookie: getCookie/setCookie/deleteCookie
 *   cors, logger
 * 原项目代码无需改动, 只需替换 import 来源。
 */

// ===== 路由匹配 (Hono 风格: /admin/api/providers/:id) =====
function compilePattern(pattern) {
  if (pattern === '*' || pattern === '/*') return { regex: /^.*$/, keys: [] };
  const keys = [];
  // 去掉首尾斜杠再按段拆分
  const trimmed = pattern.replace(/^\//, '').replace(/\/+$/, '');
  if (trimmed === '') return { regex: /^\/?$/, keys };
  let regexStr = '^';
  for (const part of trimmed.split('/')) {
    if (part === '*') { regexStr += '(?:/(.*))?'; continue; }
    if (part.startsWith(':')) {
      keys.push(part.slice(1));
      regexStr += '/([^/]+)';
    } else {
      regexStr += '/' + part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  regexStr += '/?$';
  return { regex: new RegExp(regexStr), keys };
}

// ===== Context =====
class HonoRequest {
  constructor(request, app) {
    this.raw = request;
    this.url = request.url;
    this.method = request.method.toUpperCase();
    this.path = new URL(request.url).pathname;
    this.app = app;
  }
  header(name) {
    if (name) return this.raw.headers.get(name);
    return this.raw.headers;
  }
  async json() {
    return await this.raw.json();
  }
  param(name) {
    const params = this._params || {};
    return params[name];
  }
  query(name) {
    const url = new URL(this.raw.url);
    if (name) return url.searchParams.get(name) || undefined;
    return Object.fromEntries(url.searchParams);
  }
  setParams(params) { this._params = params; }
}

class Context {
  constructor(request, app, env) {
    this.req = new HonoRequest(request, app);
    this.env = env || {};
    this._vars = {};
  }
  json(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    });
  }
  html(htmlStr, status = 200, headers = {}) {
    return new Response(htmlStr, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    });
  }
  redirect(url, status = 302) {
    // Hono 兼容: 接受相对路径, 自动补全为绝对 URL
    if (url.startsWith('/')) {
      const base = new URL(this.req.url).origin;
      url = base + url;
    }
    return Response.redirect(url, status);
  }
  text(text, status = 200, headers = {}) {
    return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
  }
  set(key, value) { this._vars[key] = value; }
  get(key) { return this._vars[key]; }
}

// ===== Hono App =====
class Hono {
  constructor() {
    this.routes = [];   // { method, pattern, compiled, handler }
    this.middlewares = []; // { pattern, compiled, handler }
    this._notFound = null;
    this._onError = null;
  }

  _add(method, pattern, handler) {
    this.routes.push({ method, pattern, compiled: compilePattern(pattern), handler });
    return this;
  }
  get(p, h) { return this._add('GET', p, h); }
  post(p, h) { return this._add('POST', p, h); }
  put(p, h) { return this._add('PUT', p, h); }
  patch(p, h) { return this._add('PATCH', p, h); }
  delete(p, h) { return this._add('DELETE', p, h); }
  all(p, h) { return this._add('ALL', p, h); }
  use(pattern, handler) {
    if (typeof pattern === 'function') {
      handler = pattern;
      pattern = '*';
    }
    this.middlewares.push({ pattern, compiled: compilePattern(pattern), handler });
    return this;
  }
  notFound(h) { this._notFound = h; return this; }
  onError(h) { this._onError = h; return this; }

  async fetch(request, env) {
    const c = new Context(request, this, env);
    const path = c.req.path;
    const method = c.req.method;
    const url = new URL(request.url);

    try {
      // 中间件链 (匹配 prefix 或 *)
      const runMiddleware = async (idx) => {
        if (idx >= this.middlewares.length) return null;
        const mw = this.middlewares[idx];
        const m = mw.compiled.regex.exec(path);
        if (!m) return runMiddleware(idx + 1);
        const next = () => runMiddleware(idx + 1);
        return await mw.handler(c, next);
      };

      // 路由匹配
      const runRoute = async () => {
        for (const route of this.routes) {
          if (route.method !== 'ALL' && route.method !== method) continue;
          const m = route.compiled.regex.exec(path);
          if (!m) continue;
          const params = {};
          route.compiled.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] || ''); });
          c.req.setParams(params);
          return await route.handler(c);
        }
        if (this._notFound) return await this._notFound(c);
        return c.json({ error: { message: 'Not Found', type: 'not_found' } }, 404);
      };

      // 执行顺序: 中间件链 -> 路由; 中间件返回值若为 Response 则作为最终响应
      let resp = await runMiddleware(0);
      if (!(resp instanceof Response)) {
        resp = await runRoute();
      }

      // 注入收集到的 Cookie
      if (c._setCookies && c._setCookies.length > 0 && resp instanceof Response) {
        const h = new Headers(resp.headers);
        for (const cookie of c._setCookies) h.append('Set-Cookie', cookie);
        resp = new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
      }
      return resp;
    } catch (err) {
      console.error('[hono-compat] unhandled error:', err);
      if (this._onError) return await this._onError(err, c);
      return c.json({ error: { message: err.message || 'Internal Server Error', type: 'server_error' } }, 500);
    }
  }
}

// ===== Cookie helpers =====
export function getCookie(c, name) {
  const cookieHeader = c.req.header('Cookie') || '';
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function setCookie(c, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.maxAge) parts.push(`Max-Age=${options.maxAge}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  // 延迟到响应时设置 — 通过 c._setCookies 收集
  if (!c._setCookies) c._setCookies = [];
  c._setCookies.push(parts.join('; '));
}

export function deleteCookie(c, name, options = {}) {
  if (!c._setCookies) c._setCookies = [];
  c._setCookies.push(`${name}=; Max-Age=0; Path=${options.path || '/'}`);
}

// ===== cors 中间件 =====
export function cors(options = {}) {
  const origin = options.origin || '*';
  return async (c, next) => {
    const resp = await next();
    if (resp && resp.headers) {
      try {
        resp.headers.set('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
        resp.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        resp.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        resp.headers.set('Access-Control-Max-Age', '86400');
      } catch (e) { /* immutable headers (如 302) 忽略 */ }
    }
    return resp;
  };
}

// ===== logger 中间件 =====
export function logger() {
  return async (c, next) => {
    const start = Date.now();
    const resp = await next();
    console.log(`${c.req.method} ${c.req.path} ${resp ? resp.status : '?'} ${Date.now() - start}ms`);
    return resp;
  };
}

// ===== 类型导出 (运行时无操作) =====
export const ContextType = Context;
export const NextType = class {};

export { Context, HonoRequest, compilePattern, Hono };
export default Hono;