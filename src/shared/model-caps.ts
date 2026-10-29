/**
 * 模型能力规则 —— 渲染层与主进程共用的单一真源（纯函数、零依赖）。
 *
 * 历史问题：这套规则曾在 src/main/http.ts 与 src/renderer/src/models.ts 各写一份，
 * 结果 UI 对 gpt-image / doubao-seedream 只允许 1 张参考图，而主进程允许 16 / 14 张。
 */

/** 自动拉取模型目录的噪音过滤：ASR / TTS / 向量 / 实时传输等与创作无关的模型不进下拉 */
export const MODEL_NOISE_RE =
  /(asr|tts|embedding|rerank|realtime|livetranslate|-s2s|ocr|omni|deep-research|deep-search|qvq|qwen-vl-ocr|qwen-audio|qwen-mt|gui-|for-status|auto-handle)/i

export type ModelCap = 'image' | 'text' | 'vision'

/** 按模型 ID 推断能力标签：vl→视觉，image/wan/z-image/flux 等→生图，其余→文本 */
export function deriveCaps(id: string): ModelCap[] {
  if (/vl|vision/i.test(id)) return ['vision', 'text']
  if (/image|wan\d|z-image|flux|kolors|dall|stable|sd3|diffusion/i.test(id)) return ['image']
  return ['text']
}
