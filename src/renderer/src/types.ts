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
  plan: 'token-plan' | 'ordinary' | 'unknown'
  plainFallback: boolean
}

export interface ActiveModel {
  provider: string
  model: string
}

export interface GenParams {
  prompt: string
  negative?: string
  w: number
  h: number
  seed: number
  model: string
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
  ref?: { name: string; data: ArrayBuffer }
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
}

export interface DistillResult {
  prompt: string
  elapsed: number
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
  providers?: Record<string, { apiKey?: string }>
  activeModel?: ActiveModel
}

export interface Api {
  health(): Promise<HealthInfo>
  library(): Promise<LibraryData>
  history(): Promise<HistoryItem[]>
  generate(opts: GenOpts): Promise<GenResult>
  distill(payload: { data: ArrayBuffer; name: string }): Promise<DistillResult>
  getSettings(): Promise<SettingsShape>
  setSettings(patch: SettingsShape): Promise<unknown>
  appInfo(): Promise<AppInfo>
  saveImage(url: string): Promise<{ ok: boolean; path?: string; err?: string }>
  revealImage(url: string): Promise<{ ok: boolean }>
  imageRead(url: string): Promise<Uint8Array>
  favorites(): Promise<FavItem[]>
  toggleFavorite(item: Omit<FavItem, 'savedAt'>): Promise<FavItem[]>
  blUpdate(): Promise<{ ok: boolean; out: string }>
  openPath(kind: string): Promise<{ ok: boolean }>
  testProvider(provider: string): Promise<{ ok: boolean; out: string }>
  bailianKeyGet(): Promise<BailianKeyInfo>
  bailianKeySet(
    key: string
  ): Promise<
    | { ok: true; info: BailianKeyInfo; plainFallback: boolean }
    | { ok: false; err: string }
  >
  bailianKeyClear(): Promise<BailianKeyInfo>
  bailianKeyTest(): Promise<{ ok: boolean; out: string }>
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
  }): Promise<AgentRunResult>
  imageChain(name: string): Promise<ChainItem[]>
  onGenProgress(cb: (e: GenProgress) => void): () => void
  onAgentProgress(cb: (e: AgentProgress) => void): () => void
}
