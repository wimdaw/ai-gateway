// EdgeOne 核心路由逻辑 — 代理 + 鉴权 + 管理后台 API
import { parseUrl, json, html, matchPath, readJson, getCookie, setCookieHeader, sha256Hex } from './router.js';
import { seedIfEmpty, getProviders, getProxyKeys, validateProxyKey, createSession, getSession, deleteSession, saveProviders, saveProxyKeys, recordUsage } from './storage.js';

const SESSION_TTL = 7 * 24 * 60 * 60;

// 管理后台鉴权(基于 Session)
async function adminAuthorized(request) {
  const sid = getCookie(request, 'session_id');
  if (!sid) return false;
  const s = await getSession(sid);
  return s !== null;
}

async function requireApiAuth(request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) {
    return json({ error: { message: '缺少或无效的 Authorization 头，格式: Bearer sk_cf_*', type: 'authentication_error' } }, 401);
  }
  const token = auth.slice(7);
  const ok = await validateProxyKey(token);
  if (!ok) {
    return json({ error: { message: 'API Key 无效或已禁用', type: 'authentication_error' } }, 401);
  }
  return null; // 通过
}

// 按模型分配到提供商
async function routeModel(model) {
  const providers = await getProviders();
  // model 可能为 "provider/model" 或直接模型 id
  const enabledProviders = providers.filter((p) => p.enabled);
  const ps = String(model || '').split('/');
  if (ps.length === 2) {
    const p = enabledProviders.find((x) => x.id === ps[0]);
    if (p) {
      const m = p.models.find((mm) => mm.id === ps[1]);
      if (m && m.enabled) return { provider: p, modelId: ps[1] };
    }
  }
  // 全局查找
  for (const p of enabledProviders) {
    const m = p.models.find((mm) => mm.id === model && mm.enabled);
    if (m) return { provider: p, modelId: model };
  }
  // 兜底: 第一个启用提供商
  const p = enabledProviders[0];
  return p ? { provider: p, modelId: model || (p.models[0] && p.models[0].id) } : null;
}

async function forwardProxy(request, model, apiKeyHeader) {
  const routed = await routeModel(model);
  if (!routed || !routed.provider) {
    return json({ error: { message: '没有可用的 AI 渠道', type: 'invalid_request_error' } }, 400);
  }
  const { provider, modelId } = routed;

  const OPENCODE_MIRRORS = [
    'https://opencode.ai.cmliussss.net/zen/v1',
    'https://opencode.fastly.cmliussss.net/zen/v1',
    'https://opencode.gcore.cmliussss.net/zen/v1',
  ];

  const isOpenCode = provider.id === 'opencode';
  const usableKeys = (provider.apiKeys || []).filter((k) => k.enabled !== false).map((k) => k.key);

  const start = Date.now();
  const body = await request.text();
  const subPath = request.url.replace(/^\/v1\//, '');

  // OpenCode 无 key 时走 public + 镜像故障转移
  if (isOpenCode && usableKeys.length === 0) {
    const ua = 'opencode/1.17.8 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13';
    const targets = [
      { base: (provider.baseUrl || '').replace(/\/+$/, ''), key: 'public' },
      ...OPENCODE_MIRRORS.map((m) => ({ base: m.replace(/\/+$/, ''), key: 'public' })),
    ];
    let lastErr = null;
    for (const t of targets) {
      try {
        const url = `${t.base}/${subPath}`;
        const hdrs = new Headers(request.headers);
        hdrs.set('Authorization', 'Bearer ' + t.key);
        hdrs.set('User-Agent', ua);
        hdrs.set('x-opencode-client', 'cli');
        hdrs.set('x-opencode-project', 'global');
        hdrs.delete('host');
        const up = await fetch(url, { method: request.method, headers: hdrs, body: body || undefined });
        const text = await up.text();
        await recordUsage({ provider: provider.name, model, token: (apiKeyHeader || '-').slice(0, 8) + '***', ok: up.status < 400, status: up.status, promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - start });
        return new Response(text, { status: up.status, headers: { 'content-type': up.headers.get('content-type') || 'application/json' } });
      } catch (e) {
        lastErr = e;
      }
    }
    await recordUsage({ provider: provider.name, model, token: (apiKeyHeader || '-').slice(0, 8) + '***', ok: false, status: 502, promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - start });
    return json({ error: { message: '上游请求失败: ' + (lastErr ? lastErr.message : '所有镜像不可用'), type: 'api_error' } }, 502);
  }

  const upstreamKey = usableKeys[0];
  if (!upstreamKey) {
    return json({ error: { message: '渠道未配置 API Key: ' + provider.name, type: 'invalid_request_error' } }, 500);
  }

  const target = (provider.baseUrl || '').replace(/\/$/, '') + '/' + subPath;
  const headers = new Headers(request.headers);
  headers.set('Authorization', 'Bearer ' + upstreamKey);
  headers.delete('host');

  let upstreamStatus;
  let respBody;
  try {
    const up = await fetch(target, { method: request.method, headers, body: body || undefined });
    upstreamStatus = up.status;
    respBody = await up.text();
  } catch (e) {
    await recordUsage({ provider: provider.name, model, token: apiKeyHeader || '-', ok: false, status: 502, promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - start });
    return json({ error: { message: '上游请求失败: ' + e.message, type: 'api_error' } }, 502);
  }

  await recordUsage({ provider: provider.name, model, token: (apiKeyHeader || '-').slice(0, 8) + '***', ok: upstreamStatus < 400, status: upstreamStatus, promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - start });

  return new Response(respBody, {
    status: upstreamStatus,
    headers: { 'content-type': headers.get('content-type') || 'application/json' },
  });
}

export { SESSION_TTL, adminAuthorized, requireApiAuth, routeModel, forwardProxy, readJson, seedIfEmpty, getProviders, getProxyKeys, validateProxyKey, createSession, getSession, deleteSession, saveProviders, saveProxyKeys, recordUsage, getCookie, setCookieHeader, sha256Hex, json, html, matchPath, parseUrl };