// EdgeOne 存储 — Pages Blob 持久化 + 内存兜底
// 边缘多实例共享状态必须用 Blob, 否则 session/key 会丢
import { getStore } from '@edgeone/pages-blob';

const mem = new Map();

let _blob = null;
function blobStore() {
  if (_blob) return _blob;
  try {
    // EdgeOne Pages 环境自动注入部署凭证
    _blob = getStore('ai-gateway');
    return _blob;
  } catch (e) {
    return null; // 本地/降级: 用内存
  }
}

function useBlob() {
  try {
    return blobStore() !== null;
  } catch {
    return false;
  }
}

export const kv = {
  async get(key) {
    const b = blobStore();
    if (b) {
      try {
        const v = await b.get(key);
        return v === undefined || v === null ? null : v;
      } catch (e) {
        // key 不存在或网络错误 -> 内存兜底
      }
    }
    const v = mem.get(key);
    return v === undefined ? null : v;
  },
  async put(key, value) {
    const b = blobStore();
    if (b) {
      try {
        await b.set(key, value);
        return;
      } catch (e) { /* 降级内存 */ }
    }
    mem.set(key, value);
  },
  async delete(key) {
    const b = blobStore();
    if (b) {
      try { await b.delete(key); return; } catch (e) { /* 降级 */ }
    }
    mem.delete(key);
  },
  async list() {
    const b = blobStore();
    if (b) {
      try {
        const { blobs } = await b.list();
        return (blobs || []).map((k) => (typeof k === 'string' ? k : k.key));
      } catch (e) { /* 降级 */ }
    }
    return Array.from(mem.keys());
  },
};

// 序列化 JSON 存取
export async function getJSON(key, fallback = null) {
  const raw = await kv.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export async function putJSON(key, value) {
  await kv.put(key, JSON.stringify(value));
}

// 默认数据
export const DEFAULT_PROVIDERS = [
  {
    id: 'opencode',
    name: 'OpenCode',
    baseUrl: 'https://opencode.ai/zen/v1',
    apiType: 'openai',
    apiKeys: [],
    models: [
      { id: 'deepseek-v4-flash-free', enabled: true },
      { id: 'mimo-v2.5-free', enabled: true },
      { id: 'nemotron-3-ultra-free', enabled: true },
      { id: 'hy3-free', enabled: true },
    ],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

export async function seedIfEmpty() {
  if (!(await kv.get('providers'))) {
    await putJSON('providers', DEFAULT_PROVIDERS);
  }
  if (!(await kv.get('proxy:keys'))) {
    await putJSON('proxy:keys', []);
  }
}

export async function getProviders() {
  return getJSON('providers', []);
}

export async function getProxyKeys() {
  return getJSON('proxy:keys', []);
}

export async function saveProviders(list) {
  await putJSON('providers', list);
}

export async function saveProxyKeys(list) {
  await putJSON('proxy:keys', list);
}

export async function validateProxyKey(token) {
  const keys = await getProxyKeys();
  const found = keys.find((k) => k.key === token);
  return found ? found.enabled !== false : false;
}

// 会话
export async function createSession(username, ttlSeconds) {
  const sessionId = 's_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  await putJSON('admin:session:' + sessionId, { username, expiresAt: Date.now() + ttlSeconds * 1000 });
  return sessionId;
}

export async function getSession(sessionId) {
  const s = await getJSON('admin:session:' + sessionId, null);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    await kv.delete('admin:session:' + sessionId);
    return null;
  }
  return s;
}

export async function deleteSession(sessionId) {
  await kv.delete('admin:session:' + sessionId);
}

// 用量
export async function recordUsage(rec) {
  const key = 'usage:req:' + new Date().toISOString().slice(0, 10);
  const list = await getJSON(key, []);
  list.push(rec);
  await putJSON(key, list.slice(-1000));
}

export async function getUsage(days = 7) {
  const all = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const list = await getJSON('usage:req:' + d, []);
    all.push(...list);
  }
  return all;
}