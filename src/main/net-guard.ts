/**
 * 远程资源地址安全判定（纯函数、零依赖，可 node --test 直跑）。
 *
 * 背景：主进程会把模型/供应商返回的图片 URL 直接 fetch 落盘。不做校验时，
 * 一个被篡改或恶意的响应就能把主进程当 SSRF 客户端打内网，或从明文 http 拉到被替换的内容。
 * 这里只做「公网 + 加密」的必要校验，不做域名白名单（第三方供应商域名不可穷举）。
 */

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
]

/** 阿里云 OSS 产物域：DashScope 的结果图/音频可能给 http 地址，仅这一类允许降级 */
const ALIYUN_HOST = /(^|\.)aliyuncs\.com$/i

export interface UrlGuardResult {
  ok: boolean
  reason?: string
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  for (const re of PRIVATE_V4) if (re.test(h)) return true
  return false
}

/**
 * 判定一个远程图片/音频地址是否可安全下载。
 * @param opts.allowHttpAliyun 为 true 时，仅阿里云产物域允许 http（实测 TTS 返回 http 的 OSS 地址）
 */
export function checkRemoteUrl(raw: string, opts: { allowHttpAliyun?: boolean } = {}): UrlGuardResult {
  const s = String(raw || '').trim()
  if (!s) return { ok: false, reason: '地址为空' }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return { ok: false, reason: '不是合法 URL' }
  }
  if (u.username || u.password) return { ok: false, reason: 'URL 不得携带账号密码' }
  const host = u.hostname.toLowerCase()
  if (isPrivateHost(host)) return { ok: false, reason: '内网/本机地址' }
  // 单标签主机名（如 http://intranet/xxx）一律拒绝，避免 DNS 后缀补全绕过
  if (!host.includes('.') && !/^\d+(\.\d+){3}$/.test(host)) return { ok: false, reason: '非公网域名' }
  if (u.protocol === 'https:') return { ok: true }
  if (u.protocol === 'http:') {
    if (opts.allowHttpAliyun && ALIYUN_HOST.test(host)) return { ok: true }
    return { ok: false, reason: '只允许 https' }
  }
  return { ok: false, reason: '不支持的协议 ' + u.protocol }
}
