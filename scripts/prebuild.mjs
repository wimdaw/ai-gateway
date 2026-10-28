/**
 * 构建前置准备（跨平台，替代 bash 专属的 `mkdir -p` + `echo >`）：
 * EdgeOne 部署管线在 Windows cmd 下执行 npm scripts，`mkdir -p` 会直接报
 * 「命令语法不正确」导致整个构建失败；echo 重定向还会把引号写进文件。
 * 这里统一用 Node 完成目录创建与 api 子入口的 re-export 文件写入。
 */
import { mkdirSync, writeFileSync } from 'node:fs'

mkdirSync('cloud-functions/api', { recursive: true })
mkdirSync('.edgeone', { recursive: true })
writeFileSync('cloud-functions/api/[[default]].js', "export { onRequest, default } from '../[[default]].js';\n")
console.log('prebuild: cloud-functions/api/[[default]].js written')
