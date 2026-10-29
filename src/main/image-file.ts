/**
 * 图片落盘的命名与格式识别（纯函数、零依赖）—— 单独成文件是为了能被 node --test 直跑
 * （http.ts 是打包器风格的相对导入，Node 原生 ESM 解析不了）。
 */

/** 从字节头推断真实图片格式：生成/编辑接口可能返回 jpeg/webp，不能一律按 .png 存 */
export function sniffImageExt(buffer: Buffer): string {
  if (!buffer?.length) return 'png'
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') return 'gif'
  return 'png'
}

/**
 * 文件名：时间戳 + 进程内自增序号。
 * 组图（wan2.7 支持一次 12 张）会在同一毫秒内连续落盘，只用时间戳命名会让后面的图
 * 覆盖前面的（静默丢图）。
 */
export function makeImageFileName(timeMs: number, seq: number, ext: string): string {
  return `image_${timeMs}_${(seq % 1_000_000).toString(36)}.${ext}`
}
