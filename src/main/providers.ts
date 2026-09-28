import fsp from 'node:fs/promises'
import path from 'node:path'

export type HttpProvider = 'siliconflow' | 'openai'

export interface HttpGenOpts {
  provider: HttpProvider
  apiKey: string
  prompt: string
  negative?: string
  w: number
  h: number
  seed?: number
  model: string
  outputsDir: string
}

export interface HttpGenResult {
  file: string
  seed: number
}

/** HTTP 直连的多服务商文生图（改图/反推仍走百炼 bl，能力最全） */
export async function httpGenerate(o: HttpGenOpts): Promise<HttpGenResult> {
  const t0 = Date.now()
  await fsp.mkdir(o.outputsDir, { recursive: true })
  const seed = o.seed && o.seed > 0 ? o.seed : Math.floor(Math.random() * 2147483647)
  let b64: string | null = null
  let url: string | null = null

  if (o.provider === 'siliconflow') {
    const body: Record<string, unknown> = {
      model: o.model,
      prompt: o.prompt,
      image_size: `${o.w}x${o.h}`,
      batch_size: 1,
      seed
    }
    if (o.negative) body.negative_prompt = o.negative
    const r = await fetch('https://api.siliconflow.cn/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const j = (await r.json().catch(() => ({}))) as {
      message?: string
      images?: Array<{ url?: string }>
      data?: Array<{ url?: string }>
    }
    if (!r.ok) throw new Error(j.message || `HTTP ${r.status}`)
    url = j.images?.[0]?.url ?? j.data?.[0]?.url ?? null
    if (!url) throw new Error('服务商未返回图片')
  } else {
    // OpenAI gpt-image-1
    const size = o.w === o.h ? '1024x1024' : o.h > o.w ? '1024x1536' : '1536x1024'
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: o.model, prompt: o.prompt, size, n: 1 })
    })
    const j = (await r.json().catch(() => ({}))) as {
      error?: { message?: string }
      data?: Array<{ b64_json?: string; url?: string }>
    }
    if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`)
    b64 = j.data?.[0]?.b64_json ?? null
    url = j.data?.[0]?.url ?? null
    if (!b64 && !url) throw new Error('服务商未返回图片')
  }

  const file = `image_${t0}.png`
  if (b64) {
    await fsp.writeFile(path.join(o.outputsDir, file), Buffer.from(b64, 'base64'))
  } else {
    const resp = await fetch(url!)
    if (!resp.ok) throw new Error(`下载图片失败：HTTP ${resp.status}`)
    await fsp.writeFile(path.join(o.outputsDir, file), Buffer.from(await resp.arrayBuffer()))
  }
  return { file, seed }
}
