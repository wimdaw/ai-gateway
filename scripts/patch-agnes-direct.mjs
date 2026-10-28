import { getStore } from '@edgeone/pages-blob'

const EO_TOKEN = process.env.EDGEONE_TOKEN_NEW || process.env.EDGEONE_TOKEN

async function patchAgnes() {
  const store = getStore({
    name: 'ai-gateway',
    projectId: 'makers-nytyhchbbnpj',
    token: EO_TOKEN,
    consistency: 'strong'
  })

  const data = await store.get('kv/providers.json', { type: 'json' })
  const providers = JSON.parse(data.value)
  const idx = providers.findIndex(p => p.id === 'agnes')
  if (idx === -1) throw new Error('agnes provider not found')

  console.log('修改前 baseUrl:', providers[idx].baseUrl)
  console.log('修改前 models:', providers[idx].models.map(m => m.id).join(', '))

  // 改为直连 Agnes 官方上游（去掉 Koyeb 中继与模型前缀）
  providers[idx] = {
    ...providers[idx],
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    apiType: 'openai',
    type: 'openai',
    apiKeys: [
      { key: 'sk-T1OXXNNB7GTFjICVSCquaAE8FRHxskjy9aOD6Mb5UpTT3wqj', enabled: true },
      { key: 'sk-uXwuGcqZQLkPnnN0KQ9eWcx3Gp9aWwVhN51gWbbwEFpiFH1B', enabled: true },
      { key: 'sk-eBWwE6XkrVuQ9qiYLOra8xCKUO5DNlFgBAy0PnIn4pfISxeC', enabled: true },
      { key: 'sk-vHg80nPdE2mhkCfBXHbcCLX4FrmRyk1l3uhZdg5p7SvyRzr1', enabled: true },
      { key: 'sk-C2D7l0vOdQHkScDDwlMtxrp2IAuwTfc2o5nnSEFDllvlVXGF', enabled: true },
    ],
    models: [
      { id: 'agnes-2.5-pro-beta', enabled: true, alias: 'agnes-2.5-pro-beta' },
      { id: 'agnes-2.5-flash', enabled: true, alias: 'agnes-2.5-flash' },
      { id: 'agnes-3.0-flash', enabled: true, alias: 'agnes-3.0-flash' },
      { id: 'agnes-2.5-pro', enabled: true, alias: 'agnes-2.5-pro' },
      { id: 'agnes-2.0-flash', enabled: true, alias: 'agnes-2.0-flash' },
      { id: 'agnes-2.5-pro-alpha', enabled: true, alias: 'agnes-2.5-pro-alpha' },
      { id: 'agnes-image-2.1-flash', enabled: true, alias: 'agnes-image-2.1-flash' },
      { id: 'agnes-image-2.0-flash', enabled: true, alias: 'agnes-image-2.0-flash' },
      { id: 'agnes-image-2.5-flash', enabled: true, alias: 'agnes-image-2.5-flash' },
    ],
    updatedAt: new Date().toISOString(),
  }

  await store.setJSON('kv/providers.json', {
    key: 'providers',
    value: JSON.stringify(providers),
    expiresAt: null,
    updatedAt: Date.now()
  })

  console.log('修改后 baseUrl:', providers[idx].baseUrl)
  console.log('修改后 models:', providers[idx].models.map(m => m.id).join(', '))
  console.log('✅ Agnes 渠道已改为直连上游')
}

patchAgnes().catch(e => { console.error(e); process.exit(1) })
