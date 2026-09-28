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
  history: (): Promise<unknown> => ipcRenderer.invoke('history'),
  generate: (opts: unknown): Promise<unknown> => ipcRenderer.invoke('generate', opts),
  distill: (payload: { data: ArrayBuffer; name: string }): Promise<unknown> =>
    ipcRenderer.invoke('distill', payload),
  getSettings: (): Promise<Record<string, string>> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Record<string, string>): Promise<unknown> =>
    ipcRenderer.invoke('settings:set', patch),
  appInfo: (): Promise<unknown> => ipcRenderer.invoke('app:info'),
  saveImage: (url: string): Promise<{ ok: boolean; path?: string; err?: string }> =>
    ipcRenderer.invoke('image:save', url),
  revealImage: (url: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('image:reveal', url),
  imageRead: (url: string): Promise<Uint8Array> => ipcRenderer.invoke('image:read', url),
  favorites: (): Promise<unknown> => ipcRenderer.invoke('favorites:list'),
  toggleFavorite: (item: unknown): Promise<unknown> => ipcRenderer.invoke('favorites:toggle', item),
  blUpdate: (): Promise<{ ok: boolean; out: string }> => ipcRenderer.invoke('bl:update'),
  openPath: (kind: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('open:path', kind),
  testProvider: (provider: string): Promise<{ ok: boolean; out: string }> =>
    ipcRenderer.invoke('test:provider', provider),
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
