import { execSync } from 'node:child_process'
import { getStore } from '@edgeone/pages-blob'

async function syncData() {
  console.log('🔄 开始从 Cloudflare D1 (ai-gateway-db) 导出全量生产配置...\n')

  const cfToken = process.env.CLOUDFLARE_API_TOKEN_WIMDAW || process.env.CLOUDFLARE_API_TOKEN
  const cfAccount = '6358da7f0543bdf066bf353a2fd3c1ac'
  const eoToken = process.env.EDGEONE_TOKEN_NEW || process.env.EDGEONE_TOKEN

  if (!cfToken || !eoToken) {
    throw new Error('请确保环境变量 CLOUDFLARE_API_TOKEN 与 EDGEONE_TOKEN_NEW 已导出')
  }

  const cmd = `CLOUDFLARE_API_TOKEN=${cfToken} CLOUDFLARE_ACCOUNT_ID=${cfAccount} npx wrangler d1 execute ai-gateway-db --remote --command "SELECT key, value, expires_at FROM kv_store WHERE key NOT LIKE 'admin:session:%';" --json`
  const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 })
  const parsed = JSON.parse(output)
  const rows = parsed[0]?.results || []
  console.log(`成功从 D1 导出 ${rows.length} 项有效生产数据。`)

  console.log('\n🚀 开始向腾讯云 EdgeOne Blob (ai-gateway) 注入配置...')
  const store = getStore({
    name: 'ai-gateway',
    projectId: 'makers-nytyhchbbnpj',
    token: eoToken,
    consistency: 'strong'
  })

  let count = 0
  for (const row of rows) {
    const { key, value, expires_at } = row
    const blobKey = `kv/${encodeURIComponent(key)}.json`
    await store.setJSON(blobKey, {
      key,
      value,
      expiresAt: expires_at ? Number(expires_at) : null,
      updatedAt: Date.now()
    })
    count++
    console.log(`  [${count}/${rows.length}] 写入: ${key}`)
  }

  console.log(`\n✅ 全量同步完成！共迁移 ${count} 项生产配置到 EdgeOne Blob 数据库。`)
}

syncData().catch(err => {
  console.error('Sync failed:', err)
  process.exit(1)
})
