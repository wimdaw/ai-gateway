/**
 * 兼容转发层。
 *
 * 管理端实现已按域拆分到 `./admin/*`（入口见 `./admin/index.ts`）。
 * 保留本文件是为了让既有的 `import { ... } from './admin'` 原样可用 ——
 * 导出名一个不多、一个不少。
 */
export * from './admin/index'
