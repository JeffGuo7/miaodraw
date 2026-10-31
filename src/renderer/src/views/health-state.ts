/**
 * 健康状态推导 —— 一处定义，顶栏 / 状态栏 / 设置页共用。
 *
 * 背景（独立评审第 2 轮 P1）：health.ok 只探测百炼，hasAnyKey 却看全部供应商。
 * 只配了硅基流动的用户会同时看到"服务异常（红）/ 连接失败（红）/ 还没配置（中性）"三种说法，
 * 而他其实能正常出图。
 *
 * 四态语义：
 *   idle   —— 一个密钥都没配（中性，不是故障）
 *   ready  —— 配了非百炼的供应商（可用，但没有在线探测：不谎报在线，也不谎报故障）
 *   ok     —— 百炼密钥在，且探测通过
 *   bad    —— 百炼密钥在，但探测失败（这才是真故障，用红色）
 */
export type HealthState = 'unknown' | 'idle' | 'ready' | 'ok' | 'bad'

/** 只关心这几个字段，避免各调用点为了类型再写一次 cast */
export interface HealthLike {
  ok: boolean
  version?: string
  hasKey?: boolean
  hasAnyKey?: boolean
}

export function healthState(health: HealthLike | null | undefined): HealthState {
  if (!health) return 'unknown'
  const anyConfigured = !!(health.hasAnyKey ?? health.hasKey)
  if (!anyConfigured) return 'idle'
  if (health.hasKey) return health.ok ? 'ok' : 'bad'
  return 'ready'
}

export function healthLabel(state: HealthState): string {
  switch (state) {
    case 'ok':
      return '在线'
    case 'bad':
      return '连接失败'
    case 'ready':
      return '已配置'
    case 'idle':
      return '未配置'
    default:
      return '检测中'
  }
}

/** 顶栏那句话（带可执行动作） */
export function healthChipText(state: HealthState, host: string): string {
  switch (state) {
    case 'ok':
      return `服务在线 · ${host}`
    case 'bad':
      return '服务异常 · 重试'
    case 'ready':
      return '模型已配置'
    case 'idle':
      return '未配置模型 · 去设置'
    default:
      return '检测服务…'
  }
}

/** 顶栏提示 */
export function healthChipHint(state: HealthState): string {
  switch (state) {
    case 'ok':
      return '模型服务在线 · 点击刷新'
    case 'bad':
      return '已配置百炼密钥但连不上 · 点击重试'
    case 'ready':
      return '已配置第三方服务商（百炼未配置，不影响出图）· 点击刷新'
    case 'idle':
      return '还没配置任何模型密钥 · 点击去设置'
    default:
      return '检测中'
  }
}
