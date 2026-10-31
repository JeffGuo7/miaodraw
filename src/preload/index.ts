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
  health: (opts?: { force?: boolean }): Promise<HealthInfo> => ipcRenderer.invoke('health', opts),
  library: (opts?: { reload?: boolean }): Promise<unknown> => ipcRenderer.invoke('library', opts),
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
  updateDownload: (payload: { url: string; name: string; size?: number; sha512?: string }): Promise<unknown> =>
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
  /** 画布上传素材落盘：返回 media://cvs/<file> 短路径（节点 metadata 只存它，不存 base64） */
  canvasImportImage: (payload: { name?: string; data: Uint8Array | ArrayBuffer }): Promise<{ ok: boolean; url: string; name: string }> =>
    ipcRenderer.invoke('canvas:importImage', payload),
  // ── 视频生成（V1）：直连百炼异步任务；进度经 video-progress 回推（零 Pixelle 依赖） ──
  videoGenerate: (payload: { spec: unknown; runId?: string }): Promise<unknown> => ipcRenderer.invoke('video:generate', payload),
  onVideoProgress: (cb: (payload: unknown) => void): (() => void) => {
    const h = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on('video-progress', h)
    return () => ipcRenderer.removeListener('video-progress', h)
  },
  /** 探针专用（仅截图模式注册）：零成本 stub 成片结果，端到端验证落卡/入库/血统边 */
  videoDebugStub: (): Promise<unknown> => ipcRenderer.invoke('video:debugStub'),
  // ── 视频管线（V1）：作业表（幂等）+ 成本账本 ──
  videoJobs: (payload: { planId: string; stageId?: string }): Promise<unknown> => ipcRenderer.invoke('video:jobs', payload),
  videoCost: (payload: { planId: string }): Promise<unknown> => ipcRenderer.invoke('video:cost', payload),
  /** 只预估不执行（设计稿 §2.5）：返回 jobs/预估成本/modelMix，不写注册表不计账 */
  videoPlan: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('video:plan', payload),
  /** 真正执行（付费闸门 fail-closed：confirmToken 绑定 stageId+revision+付费项） */
  videoRun: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('video:run', payload),
  /** 用户确认后签发一次性凭证（绑定 stageId+revision+付费项哈希） */
  videoConfirm: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('video:confirm', payload),
  videoCancel: (payload: { planId: string; stageId: string }): Promise<unknown> => ipcRenderer.invoke('video:cancel', payload),
  videoResume: (payload: { planId: string; stageId: string; jobs?: unknown[] }): Promise<unknown> => ipcRenderer.invoke('video:resume', payload),
  /** 阶段级进度（video:progress；与单节点出片的 runId 事件同通道，按字段区分） */
  onVideoStageProgress: (cb: (payload: unknown) => void): (() => void) => {
    const h = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on('video:progress', h)
    return () => ipcRenderer.removeListener('video:progress', h)
  },
  /** 探针专用：签发一次性确认凭证（真实 UI 走闸门后由主进程签发） */
  videoDebugIssueConfirmToken: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('video:debugIssueToken', payload),
  videoDebugParseScript: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('video:debugParseScript', payload),
  videoDebugTtsProbe: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('video:debugTtsProbe', payload),
  onVideoJob: (cb: (payload: unknown) => void): (() => void) => {
    const h = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on('video:job', h)
    return () => ipcRenderer.removeListener('video:job', h)
  },
  /** 探针专用（仅截图模式注册）：幂等/成本闸门零成本断言 */
  videoDebugEnsure: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('video:debugEnsure', payload),
  videoDebugDecide: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('video:debugDecide', payload),
  videoDebugAdvance: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('video:debugAdvance', payload),
  videoDebugIssueToken: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('video:debugIssueToken', payload),
  videoDebugAuthorize: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('video:debugAuthorize', payload),
  videoDebugSeedLedger: (payload: unknown): Promise<unknown> => ipcRenderer.invoke('video:debugSeedLedger', payload),
  // ── 编排（O1）：计划/阶段 + 状态机推进 + plan:changed 事件 ──
  planCreate: (payload: { prompt: string; canvasContext?: Record<string, unknown> }): Promise<unknown> =>
    ipcRenderer.invoke('plan:create', payload),
  planAuthored: (planId: string): Promise<unknown> => ipcRenderer.invoke('plan:authored', { planId }),
  planList: (): Promise<unknown> => ipcRenderer.invoke('plan:list'),
  /** 重启恢复：把 IndexedDB 里未完成的计划快照送回主进程工作集（只补缺失，不覆盖内存新状态） */
  planRestore: (snapshots: unknown[]): Promise<unknown> => ipcRenderer.invoke('plan:restore', { snapshots }),
  planAuthorStage: (payload: { planId: string; stageOrder?: number; expectedRevision?: number }): Promise<unknown> =>
    ipcRenderer.invoke('plan:authorStage', payload),
  planPatchStage: (payload: { planId: string; stageId: string; patch: unknown; expectedRevision: number }): Promise<unknown> =>
    ipcRenderer.invoke('plan:patchStage', payload),
  planAdvance: (payload: { planId: string; stageId: string; action: string; expectedRevision: number; actor?: string }): Promise<unknown> =>
    ipcRenderer.invoke('plan:advance', payload),
  planReplan: (payload: {
    planId: string
    requestId: string
    preserveThroughStageId?: string
    ops?: unknown[]
    expectedRevision?: number
    actor?: string
    sourceMessageId?: string
  }): Promise<unknown> => ipcRenderer.invoke('plan:replan', payload),
  planCancel: (planId: string): Promise<unknown> => ipcRenderer.invoke('plan:cancel', { planId }),
  planSetAutoAdvance: (payload: { planId: string; enabled: boolean; expectedRevision?: number }): Promise<unknown> =>
    ipcRenderer.invoke('plan:setAutoAdvance', payload),
  planEvents: (planId?: string): Promise<unknown> => ipcRenderer.invoke('plan:events', { planId }),
  /** C6 探针专用：构造「规划中断」异常态（仅截图模式注册，产品路径不用） */
  planDebugInterrupt: (payload: { planId: string; ageMs?: number }): Promise<unknown> => ipcRenderer.invoke('plan:debugInterrupt', payload),
  planDelete: (planId: string): Promise<unknown> => ipcRenderer.invoke('plan:delete', { planId }),
  onPlanChanged: (cb: (payload: unknown) => void): (() => void) => {
    const h = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on('plan:changed', h)
    return () => ipcRenderer.removeListener('plan:changed', h)
  },
  onPlanEvent: (cb: (payload: unknown) => void): (() => void) => {
    const h = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on('plan:event', h)
    return () => ipcRenderer.removeListener('plan:event', h)
  },
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
