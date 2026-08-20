// EdgeOne 管理后台 API + 页面
import { json, html, readJson, getCookie, setCookieHeader } from './router.js';
import { getProviders, getProxyKeys, getSession, saveProviders, saveProxyKeys, createSession, deleteSession, getUsage } from './storage.js';

async function ensureAdminAuth(request) {
  const sid = getCookie(request, 'session_id');
  const s = sid ? await getSession(sid) : null;
  return s !== null;
}

const PAGE_CSS = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:#0f1115;color:#e6e8eb;min-height:100vh}header{padding:20px 32px;background:#16181d;border-bottom:1px solid #2a2d34;display:flex;justify-content:space-between;align-items:center}header h1{font-size:20px}nav a{color:#8ab4ff;text-decoration:none;margin-left:16px}.container{max-width:960px;margin:24px auto;padding:0 20px}.card{background:#16181d;border:1px solid #2a2d34;border-radius:10px;padding:20px;margin-bottom:16px}h2{font-size:17px;margin-bottom:12px}button{background:#3b82f6;color:#fff;border:none;padding:9px 16px;border-radius:6px;cursor:pointer;margin:4px}button.danger{background:#dc2626}input,select{background:#0f1115;border:1px solid #3a3e45;color:#fff;padding:8px 10px;border-radius:6px;margin:4px;min-width:180px}label{display:block;margin:6px 0 2px;font-size:13px;color:#9aa0a6}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.muted{color:#9aa0a6;font-size:13px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #2a2d34;padding:8px 10px;text-align:left;font-size:14px}th{background:#1f2228}`;

function layout(title, body, loggedIn) {
  return html(`<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${PAGE_CSS}</style></head><body><header><h1>AI Gateway</h1><nav>${loggedIn ? '<a href="/">首页</a><a href="/admin">管理后台</a><a href="/admin/logout">退出</a>' : '<a href="/admin/login">登录</a>'}</nav></header><div class="container">${body}</div></body></html>`);
}

async function serveHome() {
  const sid = getCookie(new Request('http://x', { headers: {} }), 'x');
  const loggedIn = false;
  const status = {
    name: 'AI Gateway',
    version: '1.0',
    status: 'operational',
    providers: (await getProviders()).length,
  };
  return layout('AI Gateway', `
    <div class="card"><h2>状态</h2><p class="muted">${JSON.stringify(status)}</p></div>
    <div class="card"><h2>开始使用</h2>
      <p>Base URL: <code>/v1</code></p>
      <p>使用令牌 (sk_cf_*) 作为 Bearer token 调用。</p>
    </div>`, loggedIn);
}

async function serveModelsPage() {
  const providers = await getProviders();
  const models = [];
  for (const p of providers) for (const m of p.models) models.push({ id: p.id + '/' + m.id, enabled: m.enabled });
  return json({ object: 'list', data: models.map((m) => ({ id: m.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: m.id.split('/')[0] })) });
}

// --- 管理后台 API ---
async function apiStatus() {
  const providers = await getProviders();
  const keys = await getProxyKeys();
  return json({ success: true, providers: providers.length, keys: keys.length, online: providers.filter((p) => p.enabled).length });
}

async function apiGetProviders() {
  return json({ success: true, data: await getProviders() });
}

async function apiSaveProviders(request) {
  const body = await readJson(request);
  const list = body.providers || body.data || [];
  if (!Array.isArray(list)) return json({ success: false, message: '格式错误' }, 400);
  await saveProviders(list);
  return json({ success: true, data: list });
}

async function apiGetKeys() {
  return json({ success: true, data: await getProxyKeys() });
}

async function apiCreateKey(request) {
  const body = await readJson(request);
  const key = 'sk_cf_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const entry = { id: 'k_' + Date.now().toString(36), key, name: body.name || '未命名', enabled: true, createdAt: new Date().toISOString(), expiresAt: body.expiresAt || null };
  const keys = await getProxyKeys();
  keys.push(entry);
  await saveProxyKeys(keys);
  return json({ success: true, data: entry });
}

async function apiDeleteKey(request, params) {
  const keys = await getProxyKeys();
  const next = keys.filter((k) => k.id !== params.id);
  await saveProxyKeys(next);
  return json({ success: true });
}

async function apiUsage() {
  const usage = await getUsage(7);
  const total = usage.length;
  const ok = usage.filter((u) => u.ok).length;
  return json({ success: true, total, ok, failed: total - ok, records: usage.slice(-50) });
}

async function doLogin(request) {
  const { username, password } = await readJson(request);
  const env = (request && request.env) || {};
  const adminUser = env.ADMIN_USERNAME || 'admin';
  const adminPass = env.ADMIN_PASSWORD || 'yxy.@990524gdg';
  if (username !== adminUser || password !== adminPass) return json({ success: false, message: '用户名或密码错误' }, 401);
  const sid = await createSession(username, SESSION_TTL);
  const res = await json({ success: true, message: '登录成功' });
  res.headers.append('Set-Cookie', setCookieHeader('session_id', sid, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL }));
  return res;
}

const SESSION_TTL = 7 * 24 * 60 * 60;

export { ensureAdminAuth, serveHome, serveModelsPage, apiStatus, apiGetProviders, apiSaveProviders, apiGetKeys, apiCreateKey, apiDeleteKey, apiUsage, doLogin, layout };