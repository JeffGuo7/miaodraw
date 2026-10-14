import { contextBridge, ipcRenderer } from 'electron'

interface HealthInfo {
  ok: boolean
  version: string
  bundled: boolean
  hasKey: boolean
  libraryReady: boolean
  outputsDir: string
}

const api = {
  health: (): Promise<HealthInfo> => ipcRenderer.invoke('health'),
  library: (): Promise<unknown> => ipcRenderer.invoke('library'),
  styles: (): Promise<unknown> => ipcRenderer.invoke('styles'),
  history: (): Promise<unknown> => ipcRenderer.invoke('history'),
  historyDelete: (name: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('history:delete', name),
  generate: (opts: unknown): Promise<unknown> => ipcRenderer.invoke('generate', opts),
  distill: (payload: { data: ArrayBuffer; name: string }): Promise<unknown> =>
    ipcRenderer.invoke('distill', payload),
  /** 本地反推（离线）：本地模型出描述 + 可选文本模型改写中文 */
  distillLocal: (payload: { data: ArrayBuffer; name?: string; rewrite?: boolean }): Promise<unknown> =>
    ipcRenderer.invoke('distill:local', payload),
  distillLocalPrefetch: (): Promise<unknown> => ipcRenderer.invoke('distill:local-prefetch'),
  captionModel: (): Promise<{ model: string }> => ipcRenderer.invoke('caption:model'),
  onLocalCaptionProgress: (cb: (p: unknown) => void): (() => void) => {
    const h = (_e: unknown, data: unknown): void => cb(data)
    ipcRenderer.on('local-caption-progress', h)
    return () => ipcRenderer.removeListener('local-caption-progress', h)
  },
  getSettings: (): Promise<Record<string, string>> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Record<string, string>): Promise<unknown> =>
    ipcRenderer.invoke('settings:set', patch),
  appInfo: (): Promise<unknown> => ipcRenderer.invoke('app:info'),
  updateCheck: (): Promise<unknown> => ipcRenderer.invoke('update:check'),
  updateDownload: (payload: { url: string; name: string; size?: number }): Promise<unknown> =>
    ipcRenderer.invoke('update:download', payload),
  updateCancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('update:cancel'),
  updateInstall: (file: string): Promise<{ ok: boolean; out?: string }> => ipcRenderer.invoke('update:install', file),
  onUpdateProgress: (cb: (p: unknown) => void): (() => void) => {
    const h = (_e: unknown, data: unknown): void => cb(data)
    ipcRenderer.on('update-progress', h)
    return () => ipcRenderer.removeListener('update-progress', h)
  },
  saveImage: (url: string): Promise<{ ok: boolean; path?: string; err?: string }> =>
    ipcRenderer.invoke('image:save', url),
  revealImage: (url: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('image:reveal', url),
  imageRead: (url: string): Promise<Uint8Array> => ipcRenderer.invoke('image:read', url),
  refsRead: (hash: string, ext: string): Promise<Uint8Array> => ipcRenderer.invoke('refs:read', hash, ext),
  canvasAssetInfo: (rel: string): Promise<unknown> => ipcRenderer.invoke('canvas:assetInfo', rel),
  pixelleEnsure: (): Promise<{ baseUrl: string }> => ipcRenderer.invoke('pixelle:ensure'),
  pixelleCheckEnv: (): Promise<{ ok: boolean; uv: boolean; backendDir: boolean; message?: string }> =>
    ipcRenderer.invoke('pixelle:checkEnv'),
  pixelleProxy: (args: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<{ status: number; json: unknown }> =>
    ipcRenderer.invoke('pixelle:proxy', args),
  imageEdit: (payload: {
    op: string
    name?: string
    data?: ArrayBuffer
    mask?: ArrayBuffer
    prompt?: string
    factor?: number
    scales?: { top?: number; bottom?: number; left?: number; right?: number }
    runId?: string
  }): Promise<unknown> => ipcRenderer.invoke('image:edit', payload),
  favorites: (): Promise<unknown> => ipcRenderer.invoke('favorites:list'),
  toggleFavorite: (item: unknown): Promise<unknown> => ipcRenderer.invoke('favorites:toggle', item),
  openPath: (kind: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('open:path', kind),
  testProvider: (provider: string): Promise<{ ok: boolean; out: string }> =>
    ipcRenderer.invoke('test:provider', provider),
  fetchModels: (provider: string): Promise<{ ok: boolean; total?: number; models?: number; out?: string }> =>
    ipcRenderer.invoke('models:fetch', provider),
  bailianKeyGet: (): Promise<{
    configured: boolean
    masked: string
    plan: 'token-plan' | 'ordinary' | 'unknown'
    plainFallback: boolean
  }> => ipcRenderer.invoke('bailian-key:get'),
  bailianKeySet: (
    key: string
  ): Promise<
    | { ok: true; info: { configured: boolean; masked: string; plan: string; plainFallback: boolean }; plainFallback: boolean }
    | { ok: false; err: string }
  > => ipcRenderer.invoke('bailian-key:set', key),
  bailianKeyClear: (): Promise<{ configured: boolean; masked: string; plan: string; plainFallback: boolean }> =>
    ipcRenderer.invoke('bailian-key:clear'),
  bailianKeyTest: (): Promise<{ ok: boolean; out: string }> => ipcRenderer.invoke('bailian-key:test'),
  bailianWsSet: (payload: { ws?: string; baseUrl?: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('bailian-ws:set', payload),
  providerKeyGet: (): Promise<Record<string, { configured: boolean; masked: string; plainFallback: boolean }>> =>
    ipcRenderer.invoke('provider-key:get'),
  providerKeySet: (
    provider: string,
    key: string
  ): Promise<
    | { ok: true; info: Record<string, { configured: boolean; masked: string; plainFallback: boolean }>; plainFallback: boolean }
    | { ok: false; err: string }
  > => ipcRenderer.invoke('provider-key:set', provider, key),
  providerKeyClear: (
    provider: string
  ): Promise<
    { ok: true; info: Record<string, { configured: boolean; masked: string; plainFallback: boolean }> } | { ok: false; err: string }
  > => ipcRenderer.invoke('provider-key:clear', provider),
  cancelRun: (runId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('gen:cancel', runId),
  modelConfigGet: (): Promise<unknown> => ipcRenderer.invoke('model-config:get'),
  modelConfigSet: (cfg: unknown): Promise<unknown> => ipcRenderer.invoke('model-config:set', cfg),
  composeSave: (payload: { dataUrl: string; width: number; height: number }): Promise<{ name: string; url: string }> =>
    ipcRenderer.invoke('compose:save', payload),
  segmentMask: (
    src: string,
    points: Array<{ x: number; y: number }>
  ): Promise<{ maskUrl: string; width: number; height: number }> => ipcRenderer.invoke('segment:mask', src, points),
  agentRun: (payload: {
    runId: string
    goal: string
    baseName?: string
    model?: string
    provider?: string
    refs?: unknown[]
  }): Promise<unknown> => ipcRenderer.invoke('agent:run', payload),
  imageChain: (name: string): Promise<unknown> => ipcRenderer.invoke('image:chain', name),
  onGenProgress: (cb: (e: { runId: string; stage: string; detail?: string }) => void): (() => void) => {
    const h = (_e: unknown, data: { runId: string; stage: string; detail?: string }): void => cb(data)
    ipcRenderer.on('gen-progress', h)
    return () => ipcRenderer.removeListener('gen-progress', h)
  },
  onAgentProgress: (cb: (e: unknown) => void): (() => void) => {
    const h = (_e: unknown, data: unknown): void => cb(data)
    ipcRenderer.on('agent-progress', h)
    return () => ipcRenderer.removeListener('agent-progress', h)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
