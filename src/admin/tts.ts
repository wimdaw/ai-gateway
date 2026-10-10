/**
 * Azure TTS 音色试听（返回 audio/mpeg）。
 */
import { Context } from 'hono'
import { fail } from '../http'
import { getProvider } from '../storage'
import type { Env } from '../types'

// ===== Azure TTS 音色试听 =====

export async function handleTtsPreview(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<{ provider?: string; voice?: string; text?: string }>().catch(() => ({} as { provider?: string; voice?: string; text?: string }))
  const providerId = body.provider || 'tts'
  const provider = await getProvider(c.env, providerId)
  if (!provider) return fail(c, `渠道 "${providerId}" 不存在`, 404)
  if ((provider.type || 'openai') !== 'azure-tts') {
    return fail(c, `渠道 "${providerId}" 不是 azure-tts 类型`, 400)
  }
  const { synthesizeAzureTts } = await import('../azure-tts')
  const voice = body.voice || provider.voice || 'zh-CN-XiaoxiaoNeural'
  // 试听文本按音色语言自动匹配, 避免中文音色念英文
  const previewText = (v: string): string => {
    if (v.startsWith('zh-')) return '你好,这是语音试听,欢迎使用。'
    if (v.startsWith('ja-')) return 'こんにちは、これは音声プレビューです。'
    if (v.startsWith('ko-')) return '안녕하세요, 음성 미리보기입니다.'
    if (v.startsWith('fr-')) return 'Bonjour, ceci est un aperçu vocal.'
    if (v.startsWith('de-')) return 'Hallo, dies ist eine Sprachvorschau.'
    if (v.startsWith('ru-')) return 'Здравствуйте, это голосовой предпросмотр.'
    if (v.startsWith('es-')) return 'Hola, esta es una vista previa de voz.'
    if (v.startsWith('it-')) return 'Ciao, questa è un\'anteprima vocale.'
    if (v.startsWith('pt-')) return 'Olá, esta é uma prévia de voz.'
    if (v.startsWith('ar-')) return 'مرحباً، هذه معاينة صوتية.'
    if (v.startsWith('hi-')) return 'नमस्ते, यह एक आवाज़ पूर्वावलोकन है।'
    if (v.startsWith('id-')) return 'Halo, ini adalah pratinjau suara.'
    if (v.startsWith('th-')) return 'สวัสดี นี่คือตัวอย่างเสียง'
    if (v.startsWith('vi-')) return 'Xin chào, đây là bản xem trước giọng nói.'
    if (v.startsWith('tr-')) return 'Merhaba, bu bir ses önizlemesidir.'
    if (v.startsWith('pl-')) return 'Cześć, to jest podgląd głosu.'
    if (v.startsWith('nl-')) return 'Hallo, dit is een spraakvoorbeeld.'
    if (v.startsWith('sv-')) return 'Hej, detta är en röstförhandsvisning.'
    if (v.startsWith('uk-')) return 'Привіт, це голосовий попередній перегляд.'
    if (v.startsWith('cs-')) return 'Ahoj, toto je hlasová ukázka.'
    if (v.startsWith('da-')) return 'Hej, dette er en stemmeprøve.'
    if (v.startsWith('fi-')) return 'Hei, tämä on ääniesikatselu.'
    if (v.startsWith('el-')) return 'Γεια σας, αυτή είναι μια προεπισκόπηση φωνής.'
    if (v.startsWith('he-')) return 'שלום, זוהי תצוגה מקדימה של קול.'
    if (v.startsWith('nb-')) return 'Hei, dette er en taleprøve.'
    if (v.startsWith('en-')) return 'Hello, this is a voice preview.'
    return '你好,这是语音试听,欢迎使用。'
  }
  const text = (body.text || previewText(voice)).slice(0, 100)
  try {
    const { audio, usedVoice } = await synthesizeAzureTts(text, {
      voice,
      rate: provider.rate || '+0%',
      volume: provider.volume || '+0%',
      pitch: provider.pitch || '+0Hz',
    })
    return new Response(audio, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audio.byteLength),
        'X-Azure-TTS-Voice': usedVoice,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(c, `试听失败: ${message}`, 502)
  }
}

