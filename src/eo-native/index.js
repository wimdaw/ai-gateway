// EdgeOne Pages 主入口 — 路由分发
// 所有模块通过 esbuild 内联打包为单文件
import { parseUrl, json, html, matchPath, readJson } from './router.js';
import { seedIfEmpty, getProviders, getProxyKeys } from './storage.js';
import { requireApiAuth, forwardProxy } from './handler.js';
import { ensureAdminAuth, serveHome, serveModelsPage, apiStatus, apiGetProviders, apiSaveProviders, apiGetKeys, apiCreateKey, apiDeleteKey, apiUsage, doLogin, layout } from './admin.js';

// 入口 — 显式导出以便 esbuild 保留
export async function __eoEntry(context) {
  const request = context.request;
  const env = context.env || {};

  // 注入 env 供登录使用
  request.env = env;

  await seedIfEmpty();

  const { path, method } = parseUrl(request);

  // ===== 首页 =====
  if (method === 'GET' && path === '/') return serveHome();

  // ===== 管理后台 =====
  if (path === '/admin/login' && method === 'GET') {
    return layout('登录', `<div class="card"><h2>管理员登录</h2><form id="f"><label>用户名</label><input id="u"><label>密码</label><input id="p" type="password"><br><button type="submit">登录</button></form></div><script>const f=document.getElementById('f');f.onsubmit=async e=>{e.preventDefault();const r=await fetch('/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})});const j=await r.json();if(j.success)location.href='/admin';else alert(j.message)};</script>`, false);
  }
  if (path === '/admin/login' && method === 'POST') return doLogin(request);
  if (path === '/admin/logout') {
    const res = new Response(null, { status: 302, headers: { location: '/' } });
    res.headers.append('Set-Cookie', 'session_id=; Max-Age=0; Path=/');
    return res;
  }

  // ===== 管理后台 API(需 Session) =====
  if (path.startsWith('/admin')) {
    const authed = await ensureAdminAuth(request);
    if (!authed) {
      if (path.startsWith('/admin/api/')) return json({ success: false, message: '未登录' }, 401);
      return new Response(null, { status: 302, headers: { location: '/admin/login' } });
    }
    if (path === '/admin') {
      return layout('管理后台', `
        <div class="card"><h2>系统状态</h2><div id="status">加载中...</div></div>
        <div class="card"><h2>提供商</h2><div id="providers"></div><button onclick="addProvider()">+ 添加渠道</button></div>
        <div class="card"><h2>转发 Key</h2><button onclick="newKey()">+ 生成 Key</button><div id="keys"></div></div>
        <div class="card"><h2>用量统计</h2><div id="usage"></div></div>
        <script>
        async function load(){const s=await(await fetch('/admin/api/status')).json();document.getElementById('status').textContent='渠道 '+s.providers+' 个 / Key '+s.keys+' 个 / 在线 '+s.online+' 个';
        const p=await(await fetch('/admin/api/providers')).json();document.getElementById('providers').textContent=JSON.stringify(p.data,null,2);
        const k=await(await fetch('/admin/api/proxy-keys')).json();document.getElementById('keys').innerHTML=k.data.map(x=>'<div class="row"><code>'+x.key+'</code><button class="danger" onclick="delKey(\\''+x.id+'\\')">删除</button></div>').join('');
        const u=await(await fetch('/admin/api/usage')).json();document.getElementById('usage').textContent='总请求 '+u.total+' / 成功 '+u.ok+' / 失败 '+u.failed;}
        async function newKey(){const r=await(await fetch('/admin/api/proxy-keys',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();if(r.data)alert('新 Key: '+r.data.key);load();}
        async function delKey(id){await fetch('/admin/api/proxy-keys/'+id,{method:'DELETE'});load();}
        function addProvider(){const name=prompt('渠道名称');const base=prompt('Base URL');if(name&&base){fetch('/admin/api/providers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({providers:(await(await fetch('/admin/api/providers')).json()).data.concat([{id:name.toLowerCase(),name,baseUrl:base,apiKeys:[],models:[],enabled:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}])})}).then(()=>load());}}
        load();
        </script>`, true);
    }
    if (path === '/admin/api/status') return apiStatus();
    if (path === '/admin/api/providers' && method === 'GET') return apiGetProviders();
    if (path === '/admin/api/providers' && method === 'POST') return apiSaveProviders(request);
    if (path === '/admin/api/proxy-keys' && method === 'GET') return apiGetKeys();
    if (path === '/admin/api/proxy-keys' && method === 'POST') return apiCreateKey(request);
    if (path.startsWith('/admin/api/proxy-keys/') && method === 'DELETE') {
      const params = matchPath('/admin/api/proxy-keys/:id', path).params;
      return apiDeleteKey(request, params);
    }
    if (path === '/admin/api/usage') return apiUsage();
  }

  // ===== API 转发 =====
  if (path.startsWith('/v1')) {
    // 转发 Key 鉴权
    const authErr = await requireApiAuth(request);
    if (authErr) return authErr;

    if (method === 'GET' && path === '/v1/models') return serveModelsPage();

    // 提取 model 参数
    const url = new URL(request.url);
    let model = '';
    const bodyRaw = await request.text();
    try {
      if (bodyRaw) {
        const parsed = JSON.parse(bodyRaw);
        model = parsed.model || '';
        request._body = bodyRaw;
      }
    } catch { /* ignore */ }

    return forwardProxy(request, model, (request.headers.get('Authorization') || '').slice(7));
  }

  // ===== 404 =====
  return json({ error: { message: '接口不存在', type: 'not_found' } }, 404);
}