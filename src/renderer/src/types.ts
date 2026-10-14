export interface HealthInfo {
  ok: boolean
  version: string
  entry: string
  bundled: boolean
  hasKey: boolean
  libraryReady: boolean
  outputsDir: string
}

export interface BailianKeyInfo {
  configured: boolean
  masked: string
  plan: 'token-plan' | 'ordinary' | 'workspace' | 'unknown'
  plainFallback: boolean
}

export interface ProviderKeyInfo {
  configured: boolean
  masked: string
  plainFallback: boolean
}

export interface ActiveModel {
  provider: string
  model: string
}

export type ModelCap = 'image' | 'text' | 'vision'

/** 图像编辑操作（对应主进程 image:edit） */
export type ImageEditOp = 'repaint' | 'erase' | 'dewatermark' | 'upscale' | 'expand' | 'colorize' | 'doodle'

/** 用户为某个供应商追加的自定义模型条目 */
export interface UserModelEntry {
  id: string
  name: string
  caps: ModelCap[]
}

/** 用户自定义的 OpenAI 兼容供应商 */
export interface CustomProvider {
  id: string
  name: string
  baseUrl: string
  enabled: boolean
  models: UserModelEntry[]
}

/** 能力默认值：值形如 "provider::modelId" */
export interface ModelDefaults {
  image?: string
  text?: string
  vision?: string
}

/** 通用模型配置：供应商模板 + 自定义供应商/模型 + 能力默认值 */
export interface ModelConfig {
  extraModels?: Record<string, UserModelEntry[]>
  customProviders?: CustomProvider[]
  defaults?: ModelDefaults
  /** 从服务端 /models 拉取的模型 ID 目录（按供应商缓存） */
  fetchedModels?: Record<string, string[]>
  /** 被用户停用的供应商：创作页目录与默认值里都不再出现 */
  disabledProviders?: string[]
}

/** sidecar 里的素材条目（内容寻址：hash 指向 userData/refs/<hash><ext>） */
export interface SidecarRefInfo {
  order: number
  role?: string
  hash?: string
  name?: string
  source?: string
}

export interface GenParams {
  prompt: string
  negative?: string
  w: number
  h: number
  seed: number
  model: string
  /** 多素材融合产物：复现时据此还原素材托盘 */
  refs?: SidecarRefInfo[]
}

/** 内置风格/提示词库条目 */
export interface StyleEntry {
  id: string
  title: string
  category: string
  tags: string[]
  prompt: string
  source: string
  credit?: string
}

export interface StyleLibraryData {
  version: number
  groups: Array<{ id: string; title: string; note?: string }>
  sources?: Array<{ name: string; license: string; url?: string }>
  count: number
  styles: StyleEntry[]
}

export interface LibCase {
  n: number
  key: string
  title: string
  prompt: string
  img: string
  desc?: string
  tags?: string[]
  source?: string
  featured?: boolean
}

export interface FavItem {
  key: string
  src: 'a' | 'b'
  n: number
  title: string
  prompt: string
  img: string
  savedAt: number
}

export interface LibCategory {
  label: string
  cases: LibCase[]
}

export interface LibraryData {
  cats: Record<string, LibCategory>
  total: number
  dupsRemoved: number
}

export interface HistoryItem {
  name: string
  url: string
  mtime: number
  size: number
  params?: GenParams
}

/** 素材角色：融合时告诉模型"这张图是干什么的"（可空，仅按序号引用） */
export type RefRole = 'subject' | 'style' | 'background' | 'pose' | 'outfit' | 'sketch' | 'ref'

/** 融合素材（多素材融合用；数组顺序即提示词里的"图1/图2/图3"） */
export interface RefImage {
  name: string
  data: ArrayBuffer
  role?: RefRole
  /** 来源：本地上传 / 作品历史 / 灵感库 / 合成画布 / 剪贴板 */
  source?: 'upload' | 'history' | 'library' | 'compose' | 'clipboard'
}

export interface GenOpts {
  prompt: string
  negative?: string
  w: number
  h: number
  seed?: number
  model: string
  provider?: string
  runId?: string
  parent?: string
  /** 单素材（旧字段，等价于 refs[0]） */
  ref?: { name: string; data: ArrayBuffer }
  /** 多素材融合：顺序即图1/图2/图3，上限由所选模型能力决定 */
  refs?: RefImage[]
  /** 出图张数（组图模式为最大张数） */
  n?: number
  /** 组图模式：一次产出同角色的连续画面（wan2.7 enable_sequential） */
  sequential?: boolean
}

export interface GenProgress {
  runId: string
  stage: string
  detail?: string
}

export interface AgentProgress {
  runId: string
  stage: 'plan' | 'step' | 'done' | 'error'
  index?: number
  total?: number
  label?: string
  reply?: string
}

export interface AgentRunResult {
  reply: string
  files: Array<{ file: string; url: string }>
  last: { file: string; url: string } | null
}

export interface ChainItem {
  name: string
  url: string
}

export interface GenResult {
  file: string
  url: string
  elapsed: number
  seed: number
  model: string
  /** 组图/多图输出：全部产物（第一张即 file/url） */
  files?: Array<{ file: string; url: string }>
}

export interface DistillResult {
  prompt: string
  elapsed: number
  /** 本地反推：原始英文描述 / 使用的模型 / 是否已用文本模型改写为中文 */
  raw?: string
  model?: string
  rewritten?: boolean
}

/** 本地模型下载/推理进度 */
export interface CaptionProgress {
  stage: 'download' | 'infer'
  file?: string
  percent?: number
}

/** 应用内更新：检查结果 */
export interface UpdateInfo {
  ok: boolean
  current: string
  latest?: string
  hasUpdate?: boolean
  notes?: string
  assetName?: string
  assetUrl?: string
  assetSize?: number
  source?: 'feed' | 'github'
  out?: string
}

export interface UpdateProgress {
  stage: 'checking' | 'download' | 'done' | 'error'
  percent?: number
  received?: number
  total?: number
  detail?: string
}

export interface AppInfo {
  version: string
  name: string
  libraryRoot: string
  outputsDir: string
}

export interface SettingsShape {
  model?: string
  size?: string
  onboarded?: string
  /** 自定义更新源（返回 {version,url,notes} 的 JSON） */
  updateFeed?: string
  /** 服务商密钥只以掩码状态下发（configured/masked），明文与密文永不出主进程 */
  providerKeys?: Record<string, ProviderKeyInfo>
  activeModel?: ActiveModel
}

export interface Api {
  health(): Promise<HealthInfo>
  library(): Promise<LibraryData>
  /** 内置风格/提示词库 */
  styles(): Promise<StyleLibraryData>
  history(): Promise<HistoryItem[]>
  historyDelete(name: string): Promise<{ ok: boolean }>
  generate(opts: GenOpts): Promise<GenResult>
  distill(payload: { data: ArrayBuffer; name: string }): Promise<DistillResult>
  /** 本地反推（离线）：本地模型出描述，可选再用文本模型改写成中文 */
  distillLocal(payload: { data: ArrayBuffer; name?: string; rewrite?: boolean }): Promise<DistillResult>
  distillLocalPrefetch(): Promise<{ ok: boolean; model: string; out?: string }>
  captionModel(): Promise<{ model: string }>
  onLocalCaptionProgress(cb: (p: CaptionProgress) => void): () => void
  getSettings(): Promise<SettingsShape>
  setSettings(patch: SettingsShape): Promise<unknown>
  appInfo(): Promise<AppInfo>
  /** 检查更新（自研更新器：GitHub Releases 或自定义更新源） */
  updateCheck(): Promise<UpdateInfo>
  updateDownload(payload: { url: string; name: string; size?: number }): Promise<{ ok: boolean; file?: string; out?: string }>
  updateCancel(): Promise<{ ok: boolean }>
  updateInstall(file: string): Promise<{ ok: boolean; out?: string }>
  onUpdateProgress(cb: (p: UpdateProgress) => void): () => void
  saveImage(url: string): Promise<{ ok: boolean; path?: string; err?: string }>
  revealImage(url: string): Promise<{ ok: boolean }>
  imageRead(url: string): Promise<Uint8Array>
  /** 读取素材留档（内容寻址）；历史「复现」还原素材托盘用 */
  refsRead(hash: string, ext: string): Promise<Uint8Array>
  /** 画布资产信息（M1）：outputs/refs 只读取样（size/哈希/宽高），供 assets 索引 */
  canvasAssetInfo(rel: string): Promise<{
    size: number
    mtimeMs: number
    quickHash: string
    fullHash: string
    width: number | null
    height: number | null
    mime: string
  }>
  /** Pixelle 视频后端（M3）：确保后端已启动，返回 baseUrl */
  pixelleEnsure(): Promise<{ baseUrl: string }>
  /** Pixelle 环境预检（uv/后端目录），缺失时给可执行指引 */
  pixelleCheckEnv(): Promise<{ ok: boolean; uv: boolean; backendDir: boolean; message?: string }>
  // ── 编排（O1）：计划/阶段读写 + 状态机推进 + plan:changed 事件 ──
  /** 建计划：立即返回 drafting（route_kind=direct 时不建计划） */
  planCreate(payload: { prompt: string; canvasContext?: { hasImage?: boolean; hasText?: boolean; pixelleReady?: boolean } }): Promise<
    | { kind: 'direct' | 'ask'; direct?: boolean; capsule: unknown }
    | { kind: 'plan'; planId: string; status: string; workflow_id: string; stage_outline: unknown[]; capsule: unknown }
  >
  /** 读全量（看板渲染用） */
  planAuthored(planId: string): Promise<unknown>
  planList(): Promise<unknown>
  /** 一次只 author 当前阶段 */
  planAuthorStage(payload: { planId: string; stageOrder?: number; expectedRevision?: number }): Promise<unknown>
  /** 乐观锁内容编辑：revision 不匹配返回 conflict */
  planPatchStage(payload: { planId: string; stageId: string; patch: unknown; expectedRevision: number }): Promise<unknown>
  /** 状态机唯一入口：confirm_plan / execution_done / confirm_result / retry / block / unblock */
  planAdvance(payload: { planId: string; stageId: string; action: string; expectedRevision: number; actor?: 'chat' | 'ui' | 'auto' }): Promise<unknown>
  /** 增量协议（B 批）：stage_patch 走 patchStage；replan 为原子后缀更新 + 冻结前缀；换流程用 planCreate 新建 */
  planReplan(payload: {
    planId: string
    requestId: string
    preserveThroughStageId?: string
    ops?: unknown[]
    expectedRevision?: number
    actor?: 'chat' | 'ui' | 'auto'
    sourceMessageId?: string
  }): Promise<unknown>
  /** 取消计划（终态，可重开） */
  planCancel(planId: string): Promise<unknown>
  /** 审计事件（append-only，含 source_message_id 溯源） */
  planEvents(planId?: string): Promise<unknown>
  planDelete(planId: string): Promise<unknown>
  /** 计划变更事件（主进程 → 渲染层） */
  onPlanChanged(cb: (payload: unknown) => void): () => void
  /** 审计事件推送（主进程 → 渲染层） */
  onPlanEvent(cb: (payload: unknown) => void): () => void
  /** Pixelle REST 代理（主进程转发，规避 CORS） */
  pixelleProxy(args: { method: 'GET' | 'POST'; path: string; body?: unknown }): Promise<{ status: number; json: unknown }>
  /** 图像编辑：局部重绘 / 擦除 / 去水印 / 超分 / 扩图 / 上色 / 线稿生图 */
  imageEdit(payload: {
    op: ImageEditOp
    name?: string
    data?: ArrayBuffer
    mask?: ArrayBuffer
    prompt?: string
    factor?: number
    scales?: { top?: number; bottom?: number; left?: number; right?: number }
    runId?: string
  }): Promise<GenResult & { op: ImageEditOp }>
  favorites(): Promise<FavItem[]>
  toggleFavorite(item: Omit<FavItem, 'savedAt'>): Promise<FavItem[]>
  openPath(kind: string): Promise<{ ok: boolean }>
  testProvider(provider: string): Promise<{ ok: boolean; out: string }>
  fetchModels(provider: string): Promise<{ ok: boolean; total?: number; models?: number; out?: string }>
  bailianKeyGet(): Promise<BailianKeyInfo>
  bailianKeySet(
    key: string
  ): Promise<
    | { ok: true; info: BailianKeyInfo; plainFallback: boolean }
    | { ok: false; err: string }
  >
  bailianKeyClear(): Promise<BailianKeyInfo>
  bailianKeyTest(): Promise<{ ok: boolean; out: string }>
  bailianWsSet(payload: { ws?: string; baseUrl?: string }): Promise<{ ok: boolean }>
  providerKeyGet(): Promise<Record<string, ProviderKeyInfo>>
  providerKeySet(
    provider: string,
    key: string
  ): Promise<{ ok: true; info: Record<string, ProviderKeyInfo>; plainFallback: boolean } | { ok: false; err: string }>
  providerKeyClear(provider: string): Promise<{ ok: true; info: Record<string, ProviderKeyInfo> } | { ok: false; err: string }>
  cancelRun(runId: string): Promise<{ ok: boolean }>
  modelConfigGet(): Promise<ModelConfig>
  modelConfigSet(cfg: ModelConfig): Promise<ModelConfig>
  composeSave(payload: {
    dataUrl: string
    width: number
    height: number
  }): Promise<{ name: string; url: string }>
  segmentMask(
    src: string,
    points: Array<{ x: number; y: number }>
  ): Promise<{ maskUrl: string; width: number; height: number }>
  agentRun(payload: {
    runId: string
    goal: string
    baseName?: string
    model?: string
    provider?: string
    /** 创作页素材托盘：Agent 可用 images 参数按序号引用 */
    refs?: RefImage[]
  }): Promise<AgentRunResult>
  imageChain(name: string): Promise<ChainItem[]>
  onGenProgress(cb: (e: GenProgress) => void): () => void
  onAgentProgress(cb: (e: AgentProgress) => void): () => void
}
