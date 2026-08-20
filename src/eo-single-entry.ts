// EdgeOne Entry — 所有逻辑内联
import app from './index';

const _memStore = new Map();
const _memKv = {
  get: async (k) => { const v = _memStore.get(k); return v ? { value: v } : null; },
  put: async (k, v) => { _memStore.set(k, v); },
  delete: async (k) => { _memStore.delete(k); },
};

// 这个函数会被 esbuild 内联到 bundle 中
export async function eoHandler(context) {
  const { request, env } = context;
  // @ts-ignore
  app.provide('storage', _memKv);
  return app.fetch(request, { ...env });
}