export async function mediaUrlToFile(url: string, name: string): Promise<File> {
  const buf = await window.api.imageRead(url)
  const m = name.match(/\.(\w+)$/)
  const ext = (m?.[1] ?? 'png').toLowerCase()
  const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  return new File([ab], name, { type })
}

export async function mediaUrlData(url: string): Promise<ArrayBuffer> {
  const buf = await window.api.imageRead(url)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
