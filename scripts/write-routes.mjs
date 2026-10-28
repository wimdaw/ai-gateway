/**
 * 预写 .edgeone/routes.json
 *
 * EdgeOne 构建器在生成路由时会先检查该文件是否存在（存在则跳过自动生成），
 * 借此注入平台级重写规则：把根路径 `/` 内部重写到 `/home`。
 *
 * 原因：EdgeOne 平台对 `/` 强制由静态文件服务（filesystem 优先），静态 index.html
 * 缺失时直接返回平台 404（"The requested path does not exist"），不会回落到
 * `^/(.*)$ -> api-node` 函数路由。而本项目首页需要从 Blob 数据库实时渲染
 * （与 /admin 后台同源），不能使用静态快照页，故用重写绕过该限制。
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const routes = {
  version: 3,
  routes: [
    { handle: 'filesystem' },
    { src: '^/api/(.*)$', 'server-name': 'api-node' },
    { src: '^/(.*)$', 'server-name': 'api-node' },
  ],
  conf: {
    rewrites: [{ source: '/', destination: '/home' }],
    cloudFunctions: {
      maxDuration: 120,
    },
  },
}

mkdirSync('.edgeone', { recursive: true })
writeFileSync('.edgeone/routes.json', JSON.stringify(routes, null, 2))
console.log('✅ 已写入 .edgeone/routes.json（/ -> /home 重写）')
