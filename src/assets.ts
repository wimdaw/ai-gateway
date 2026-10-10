/**
 * 静态资源 URL（构建时由 esbuild --define 注入带内容哈希的文件名）。
 *
 * 为什么不再内联 CSS/JS：
 *  1. 内联意味着每个页面、每次访问都要重传同一份 50 KiB CSS（三个页面完全重复）；
 *  2. 外链文件可被浏览器与 Cloudflare 边缘缓存，配 `immutable` 后重复访问零传输；
 *  3. worker 包也因此不再包含这些字符串，冷启动更快。
 *
 * 文件名带内容哈希，所以可以放心用一年期强缓存：内容一变文件名就变。
 * 构建脚本见 scripts/build.mjs —— 它负责抽内容、压缩、算哈希并注入这三个常量。
 */
declare const __ASSET_CSS__: string
declare const __ASSET_SHARED_JS__: string
declare const __ASSET_ADMIN_JS__: string

export const ASSET_CSS: string = __ASSET_CSS__
export const ASSET_SHARED_JS: string = __ASSET_SHARED_JS__
export const ASSET_ADMIN_JS: string = __ASSET_ADMIN_JS__
