/**
 * EdgeOne Pages — 完整功能打包
 * 输入: src/full/entry.ts (原项目全部代码 + hono-compat)
 * 输出: functions/[[default]].js — 单文件自包含
 * EdgeOne 约束: export 必须是 `export async function onRequest` 声明式
 */
import { build } from 'esbuild'
import { mkdirSync, statSync, readFileSync, writeFileSync } from 'fs'

async function buildEdgeOne() {
  mkdirSync('functions', { recursive: true })

  try {
    await build({
      entryPoints: ['src/full/entry.ts'],
      outfile: 'functions/[[default]].js',
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      bundle: true,
      // @edgeone/pages-blob 必须内联: EdgeOne 线上不会注入该模块 (external 会导致 545)
      external: [],
      define: { 'process.env.NODE_ENV': '"production"' },
      sourcemap: false,
      minify: false,
      treeShaking: true,
      logLevel: 'silent',
    })

    let code = readFileSync('functions/[[default]].js', 'utf-8')

    // 移除 esbuild 生成的 `export { onRequest };` 等 (我们手动追加声明式)
    code = code.replace(/\nexport\s*\{\s*[^}]*\s*\};?\s*$/, '')
    // 追加 EdgeOne 要求的声明式导出
    code += '\nexport async function onRequest(context) { return __eoEntry(context); }\n'
    writeFileSync('functions/[[default]].js', code)

    const size = statSync('functions/[[default]].js').size
    console.log(`✅ EdgeOne 完整打包: functions/[[default]].js (${(size / 1024).toFixed(1)} KB)`)
  } catch (err) {
    console.error('❌ 打包失败:', err)
    process.exit(1)
  }
}

buildEdgeOne()