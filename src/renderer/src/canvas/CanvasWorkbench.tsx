/**
 * 画布工作台 — miaodraw 画布模式一级视图
 * 引擎/节点移植自 basketikun/infinite-canvas（MIT），见各文件头署名。
 *
 * 布局（自下而上）：
 *   画布（网格 + 世界层 + 连线层 + 吸附线）
 *   ├─ 左上 .ivc-topbar      工具 / 撤销重做 / 对话 / 合成 / 快捷键
 *   ├─ 下中 .ivc-toolbar     新建节点（7 类）
 *   ├─ 左下 .ivc-minimap     小地图（含视口框，可拖拽导航）
 *   ├─ 右下 .ivc-zoomctrl    缩放 + 视图设置
 *   └─ 浮层：右键菜单、快速新建菜单、计划对话、快捷键
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { Button, Popover, Progress, Segmented, Switch, Tooltip } from 'antd'
import {
  BlockOutlined,
  CheckOutlined,
  ClearOutlined,
  CopyOutlined,
  DeleteOutlined,
  DragOutlined,
  EyeOutlined,
  FileImageOutlined,
  FileTextOutlined,
  GroupOutlined,
  MessageOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  RedoOutlined,
  SearchOutlined,
  SettingOutlined,
  SoundOutlined,
  ThunderboltOutlined,
  UndoOutlined,
  ZoomInOutlined,
  ZoomOutOutlined
} from '@ant-design/icons'

import { InfiniteCanvas, type CanvasTool } from './InfiniteCanvas'
import { CanvasNode } from './CanvasNode'
import {
  canvasStore,
  useConnections,
  useGeometryVersion,
  useIsSelected,
  useNode,
  useNodeIds,
  useSelection,
  useSelectedConnection,
  useViewport
} from './store'
import { attachHistory, canRedo, canUndo, historyDepth, redo, subscribeHistory, undo } from './history'
import { getPending, registerPendingElements, subscribePending } from './pending-connection'
import { attachPlanPersistence, loadAllPlans, loadPlan } from './plan-persistence'
import { getCanvasRect } from './rect-cache'
import { fitView, focusNode, MAX_K, MIN_K } from './viewport-fit'
import { useGuides } from './guides'
import { attachVideoJobPersistence } from './video-persistence'
import ChatPanel from './ChatPanel'
import { countAssets } from './db'
import { runMigration, type MigrationProgress } from './migrate'
import ShortcutsModal from './ShortcutsModal'
import { NODE_SPECS, type CanvasNodeType, type ViewportTransform } from './types'
import { canConnect } from './connection-rules'
import { resolveNodePlacement } from './placement'
import { getCanvasPrefs, setCanvasPrefs, subscribeCanvasPrefs, type CanvasBackgroundMode, type CanvasPrefs } from './canvas-prefs'
import { clearQuickCreate, requestQuickCreate, subscribeQuickCreate, type QuickCreateRequest } from './quick-create'
import type { PlanRecord, StageRecord } from '../../../shared/plan-types'
import './canvas.css'

interface CreateAction {
  type: CanvasNodeType
  icon: JSX.Element
  label: string
  hint: string
}

/** 新建节点菜单：按「生成 / 素材 / 结构」三组，顺序按使用频率 */
const CREATE_GROUPS: Array<{ title: string; items: CreateAction[] }> = [
  {
    title: '生成',
    items: [
      { type: 'generate', icon: <ThunderboltOutlined />, label: '出图', hint: '提示词 / 参考图 → 图片' },
      { type: 'video', icon: <PlayCircleOutlined />, label: '视频', hint: '文案 / 首帧 → 成片' }
    ]
  },
  {
    title: '素材',
    items: [
      { type: 'image', icon: <FileImageOutlined />, label: '图片', hint: '拖入或上传一张图' },
      { type: 'text', icon: <FileTextOutlined />, label: '文本', hint: '写提示词 / 脚本' },
      { type: 'audio', icon: <SoundOutlined />, label: '音频', hint: '配音 / 背景音' }
    ]
  },
  {
    title: '结构',
    items: [
      { type: 'config', icon: <SettingOutlined />, label: '配置', hint: '模型与参数' },
      { type: 'group', icon: <GroupOutlined />, label: '分组', hint: '把相关节点框在一起' }
    ]
  }
]

const ADD_BUTTONS = CREATE_GROUPS.flatMap((g) => g.items)

/** 画布导航动画：220ms ease-out；任何用户手势都会打断它 */
const NAV_DURATION = 220

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

function clampScale(k: number): number {
  return Math.min(Math.max(k, MIN_K), MAX_K)
}

/** 迁移浮层：画布页首次打开跑一次历史索引，进度可中断；之后每次打开静默对账 */
function MigrationOverlay(): JSX.Element | null {
  const [progress, setProgress] = useState<MigrationProgress | null>(null)
  const [assetCount, setAssetCount] = useState<number | null>(null)
  const abortRef = useRef(false)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    runMigration(setProgress, () => abortRef.current)
      .catch(() => undefined)
      .finally(() => {
        countAssets().then(setAssetCount).catch(() => undefined)
      })
  }, [])

  // aborted 也是终态：只认 done 会让「中断」后浮层永远停在原地（用户以为卡死）
  if (!progress || progress.phase === 'done' || progress.phase === 'aborted') return null
  if (progress.phase === 'failed') {
    return (
      <div className="ivc-migration-mask ivc-no-zoom">
        <div className="ivc-migration-card">
          <div>历史索引失败：{progress.error}</div>
          <Button size="small" onClick={() => { startedRef.current = false; setProgress(null) }}>
            关闭（可稍后重开画布页重试）
          </Button>
        </div>
      </div>
    )
  }
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : progress.phase === 'scanning' ? 0 : 100
  return (
    <div className="ivc-migration-mask ivc-no-zoom">
      <div className="ivc-migration-card">
        <div style={{ marginBottom: 8 }}>
          {progress.phase === 'scanning' ? '扫描历史作品…' : '正在建立画布资产索引（原文件不动，只建目录）'}
          {assetCount != null && ' · 现有 ' + assetCount + ' 条'}
        </div>
        <Progress percent={pct} size="small" />
        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            {progress.done}/{progress.total}
          </span>
          <Button size="small" onClick={() => { abortRef.current = true }}>
            中断
          </Button>
        </div>
      </div>
    </div>
  )
}

interface Snapshot {
  plan: PlanRecord
  stages: StageRecord[]
}

/**
 * 确保计划卡节点存在（C2/C6）：已存在则复用。
 * 新建时按 3 列网格错位摆放——历史实现固定落 (24,24)，多个计划会完全重叠成一张卡。
 */
function ensurePlanNode(planId: string): void {
  const nodes = canvasStore.getState().nodes
  if (nodes.some((n) => n.type === 'plan' && n.metadata.planId === planId)) return
  const count = nodes.filter((n) => n.type === 'plan').length
  // 计划卡实际高度随阶段数增长（4 阶段约 700px+），行距按 780 留足，避免多计划卡叠在一起
  const id = canvasStore.addNode('plan', { x: 24 + (count % 3) * 520, y: 24 + Math.floor(count / 3) * 780 })
  canvasStore.updateNode(id, { metadata: { planId } })
}

/** 节点宿主：只订阅自己的节点与选中态 —— 拖动一个节点不会重渲染其它节点（P1-10） */
function CanvasNodeHost({ id }: { id: string }): JSX.Element | null {
  const node = useNode(id)
  const selected = useIsSelected(id)
  if (!node) return null
  return <CanvasNode node={node} selected={selected} />
}

/**
 * 在指定位置新建节点。
 * - 从端口点开（有 sourceNodeId）：落在源节点右侧 96px，纵向与源对齐；重叠时向下避让
 * - 空白落点：就放在落点
 * 有源节点时自动连线——这是「点一下端口就长出一张下游卡片」的关键手感。
 */
function createNodeAt(type: CanvasNodeType, req: QuickCreateRequest): string {
  const nodes = canvasStore.getState().nodes
  let x = Math.round(req.world.x)
  let y = Math.round(req.world.y)
  if (req.sourceNodeId) {
    const src = nodes.find((n) => n.id === req.sourceNodeId)
    if (src) {
      x = Math.round(src.x + src.width + 96)
      y = Math.round(src.y)
    }
  }
  // 重叠避让统一走 placement（store.addNode 内部同样会再校一次，这里先算好是为了端口方向的语义）
  const spot = resolveNodePlacement(nodes, NODE_SPECS[type], x, y)
  const id = canvasStore.addNode(type, spot)
  if (req.sourceNodeId) {
    const st = canvasStore.getState()
    const from = st.nodes.find((n) => n.id === req.sourceNodeId)
    const to = st.nodes.find((n) => n.id === id)
    if (from && to) {
      const check = canConnect(from, to)
      if (check.ok) canvasStore.addConnection(from.id, to.id)
    }
  }
  return id
}

export default function CanvasWorkbench({ onOpenCompose }: { onOpenCompose?: () => void } = {}): JSX.Element {
  const ids = useNodeIds()
  const viewport = useViewport()
  const selection = useSelection()
  const undoable = useSyncExternalStore(subscribeHistory, canUndo)
  const redoable = useSyncExternalStore(subscribeHistory, canRedo)
  const prefs = useSyncExternalStore(subscribeCanvasPrefs, getCanvasPrefs)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [tool, setTool] = useState<CanvasTool>('select')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; worldX: number; worldY: number; nodeId: string | null } | null>(null)
  const [quickCreate, setQuickCreate] = useState<{ req: QuickCreateRequest; x: number; y: number } | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [viewSettingsOpen, setViewSettingsOpen] = useState(false)
  const animRef = useRef<number | null>(null)
  const marqueeRef = useRef<HTMLDivElement | null>(null)

  const setViewport = useCallback((vp: ViewportTransform): void => {
    canvasStore.setViewport(vp)
  }, [])

  /** 带动画的视口导航（适配全部 / 聚焦节点 / 100%）：用户一动手就取消 */
  const animateTo = useCallback((target: ViewportTransform): void => {
    if (animRef.current) cancelAnimationFrame(animRef.current)
    const from = canvasStore.getState().viewport
    const t0 = performance.now()
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / NAV_DURATION)
      const e = easeOutCubic(p)
      canvasStore.setViewport({
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        k: from.k + (target.k - from.k) * e
      })
      animRef.current = p < 1 ? requestAnimationFrame(step) : null
    }
    animRef.current = requestAnimationFrame(step)
  }, [])

  /** 用户手势/滚轮优先：打断导航动画 */
  const interruptNav = useCallback((): void => {
    if (animRef.current) {
      cancelAnimationFrame(animRef.current)
      animRef.current = null
    }
  }, [])

  const canvasSize = (): { width: number; height: number } => {
    const rect = getCanvasRect()
    return { width: rect.width || 800, height: rect.height || 600 }
  }

  /**
   * 框选（marquee）：背景按住拖动 → 世界矩形与节点 AABB 相交即选中。
   * 移动 < 4px 视为「点空白」→ 清空选择。
   * 拖动过程中不 setState：矩形直接写 DOM，节点高亮走 data 属性预览，松手才提交一次选中集。
   */
  const startMarquee = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (tool !== 'select') return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const additive = e.shiftKey || e.ctrlKey || e.metaKey
      const baseSelection = additive ? canvasStore.getState().selectedIds.slice() : []
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      let cur = { x: sx, y: sy }
      let frame: number | null = null
      let moved = false
      let previewHit: string[] = []
      const elements = new Map<string, HTMLElement>()
      const prevPreview = new Set<string>()
      const marqueeEl = marqueeRef.current
      if (marqueeEl) {
        marqueeEl.style.display = 'block'
        marqueeEl.style.left = sx + 'px'
        marqueeEl.style.top = sy + 'px'
        marqueeEl.style.width = '0px'
        marqueeEl.style.height = '0px'
      }

      const paintPreview = (hit: string[]): void => {
        const next = new Set(hit)
        if (elements.size === 0) {
          containerRef.current?.querySelectorAll<HTMLElement>('[data-node-id]').forEach((el) => {
            const id = el.dataset.nodeId
            if (id) elements.set(id, el)
          })
        }
        for (const [id, el] of elements) {
          const want = next.has(id) || baseSelection.includes(id)
          if (want) {
            if (el.dataset.previewSelected !== 'true') el.dataset.previewSelected = 'true'
            prevPreview.add(id)
          } else if (prevPreview.has(id)) {
            delete el.dataset.previewSelected
            prevPreview.delete(id)
          }
        }
      }

      const apply = (): void => {
        frame = null
        const w = Math.abs(cur.x - sx)
        const h = Math.abs(cur.y - sy)
        if (w < 4 && h < 4) return
        moved = true
        const vp = canvasStore.getState().viewport
        const wx1 = (Math.min(sx, cur.x) - vp.x) / vp.k
        const wy1 = (Math.min(sy, cur.y) - vp.y) / vp.k
        const wx2 = (Math.max(sx, cur.x) - vp.x) / vp.k
        const wy2 = (Math.max(sy, cur.y) - vp.y) / vp.k
        previewHit = canvasStore
          .getState()
          .nodes.filter((n) => n.x + n.width >= wx1 && n.x <= wx2 && n.y + n.height >= wy1 && n.y <= wy2)
          .map((n) => n.id)
        paintPreview(previewHit)
        if (marqueeEl) {
          marqueeEl.style.left = Math.min(sx, cur.x) + 'px'
          marqueeEl.style.top = Math.min(sy, cur.y) + 'px'
          marqueeEl.style.width = w + 'px'
          marqueeEl.style.height = h + 'px'
        }
      }
      const move = (ev: PointerEvent): void => {
        cur = { x: ev.clientX - rect.left, y: ev.clientY - rect.top }
        if (frame === null) frame = requestAnimationFrame(apply)
      }
      const up = (): void => {
        if (frame !== null) cancelAnimationFrame(frame)
        apply()
        for (const id of prevPreview) {
          const el = elements.get(id)
          if (el) delete el.dataset.previewSelected
        }
        prevPreview.clear()
        if (marqueeEl) marqueeEl.style.display = 'none'
        if (moved) {
          canvasStore.setSelection(additive ? [...new Set([...baseSelection, ...previewHit])] : previewHit)
        } else if (!additive) {
          canvasStore.setSelection([])
        }
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [tool]
  )

  /** 适配全部节点（F / Ctrl+2）：缩放并居中到全部内容 */
  const fitAll = useCallback((): void => {
    const vp = fitView(canvasStore.getState().nodes, canvasSize())
    if (vp) animateTo(vp)
  }, [animateTo])

  /** 聚焦选中的单个节点（Shift+F / Ctrl+3）：该节点占视口约 60% */
  const focusSelected = useCallback((): void => {
    const st = canvasStore.getState()
    const id = st.selectedIds[0]
    if (!id) return
    const node = st.nodes.find((n) => n.id === id)
    if (!node) return
    const vp = focusNode(node, canvasSize())
    if (vp) animateTo(vp)
  }, [animateTo])

  const zoomAtCenter = useCallback(
    (factor: number): void => {
      const vp = canvasStore.getState().viewport
      const k = clampScale(vp.k * factor)
      const el = containerRef.current
      const cx = (el ? el.clientWidth / 2 : 400) - vp.x
      const cy = (el ? el.clientHeight / 2 : 300) - vp.y
      const wx = cx / vp.k
      const wy = cy / vp.k
      animateTo({ x: cx - wx * k, y: cy - wy * k, k })
    },
    [animateTo]
  )

  /**
   * 新建节点后把它带进视野：落在屏幕外的卡片在无限画布上等于「没创建成功」。
   * 只做最小位移（不缩放），并且走跟 fit/focus 同一套 220ms 缓动。
   */
  const revealNode = useCallback(
    (id: string): void => {
      const node = canvasStore.getState().nodes.find((n) => n.id === id)
      if (!node) return
      const size = canvasSize()
      const vp = canvasStore.getState().viewport
      const margin = 64
      const left = vp.x + node.x * vp.k
      const top = vp.y + node.y * vp.k
      const right = left + node.width * vp.k
      const bottom = top + node.height * vp.k
      let dx = 0
      let dy = 0
      if (right > size.width - margin) dx = size.width - margin - right
      else if (left < margin) dx = margin - left
      if (bottom > size.height - margin) dy = size.height - margin - bottom
      else if (top < margin) dy = margin - top
      if (!dx && !dy) return
      animateTo({ x: vp.x + dx, y: vp.y + dy, k: vp.k })
    },
    [animateTo]
  )

  /** 新建节点并保证看得见（工具条 / 右键菜单 / 空状态三处共用） */
  const addAndReveal = useCallback(
    (type: CanvasNodeType, at?: { x: number; y: number }): void => {
      const id = canvasStore.addNode(type, at)
      revealNode(id)
    },
    [revealNode]
  )

  const resetZoom = useCallback((): void => {
    const vp = canvasStore.getState().viewport
    const el = containerRef.current
    const cx = el ? el.clientWidth / 2 : 400
    const cy = el ? el.clientHeight / 2 : 300
    const wx = (cx - vp.x) / vp.k
    const wy = (cy - vp.y) / vp.k
    animateTo({ x: cx - wx, y: cy - wy, k: 1 })
  }, [animateTo])

  // 删除计划卡 = 放弃该计划：同步取消主进程计划，避免重启后被 plan:restore 重新拉起
  useEffect(() => {
    canvasStore.setPlanDeleteHandler((planId) => {
      void window.api.planCancel(planId).catch(() => undefined)
    })
    return () => canvasStore.setPlanDeleteHandler(null)
  }, [])

  // 撤销/重做：订阅画布变更（250ms 合并），并暴露给探针
  useEffect(() => attachHistory(), [])
  useEffect(() => {
    ;(window as unknown as { __canvasHistory?: unknown }).__canvasHistory = { undo, redo, canUndo, canRedo, depth: historyDepth }
    ;(window as unknown as { __canvasView?: unknown }).__canvasView = { fitAll, focusSelected }
  }, [fitAll, focusSelected])

  // 编排（O1）：订阅 plan:changed 落 IndexedDB + 迁移断言（plan 是真相源，画布只是视图）
  useEffect(() => attachPlanPersistence(), [])

  // 视频管线（V1）：订阅 video:job 落 IndexedDB（job key 幂等，重复事件覆盖不新增）
  useEffect(() => attachVideoJobPersistence(), [])

  // C2：计划建立后自动落一张计划卡（唯一新增节点类型），已存在则复用
  useEffect(() => {
    const off = window.api.onPlanChanged((raw) => {
      const snap = raw as { plan?: { id?: string; title?: string } } | undefined
      const planId = snap?.plan?.id
      if (!planId) return
      ensurePlanNode(planId)
    })
    return off
  }, [])

  // C6 重启续跑：主进程 registry 是纯内存工作集，重启即空。
  // 不把 IndexedDB 里未完成的计划回灌，计划卡会永远停在「载入计划…」。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const plans = await loadAllPlans()
        // 只恢复未完成的计划：done / cancelled 是终态，重启不需要回到画布占位
        const unfinished = plans.filter((p) => p.status === 'running' || p.status === 'blocked' || p.status === 'drafting')
        if (!unfinished.length || cancelled) return
        const snapshots: Snapshot[] = []
        for (const p of unfinished) {
          const { plan, stages } = await loadPlan(p.id)
          if (plan) snapshots.push({ plan, stages })
        }
        if (!snapshots.length || cancelled) return
        const res = (await window.api.planRestore(snapshots)) as { restored?: number; skipped?: number } | undefined
        if (cancelled) return
        // 只为「主进程确实持有」的计划建卡；被跳过的（自洽性校验失败/已存在）不建，避免死卡
        const list = (await window.api.planList()) as Array<{ id?: string }> | undefined
        const alive = new Set((Array.isArray(list) ? list : []).map((p) => p?.id).filter(Boolean) as string[])
        for (const s of snapshots) if (alive.has(s.plan.id)) ensurePlanNode(s.plan.id)
        if (res?.restored) console.info('[canvas] 重启续跑：恢复 ' + res.restored + ' 个计划（跳过 ' + (res.skipped ?? 0) + '）')
      } catch (e) {
        console.warn('[canvas] 计划恢复失败：', e instanceof Error ? e.message : e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 关闭快速新建菜单
  const closeQuickCreate = useCallback((clearPending = true): void => {
    setQuickCreate(null)
    if (clearPending) clearQuickCreate()
  }, [])

  // 端口点击 / 空白落点 → 快速新建菜单
  useEffect(() => {
    return subscribeQuickCreate((req) => {
      const rect = containerRef.current?.getBoundingClientRect()
      const width = 252
      const maxX = (rect?.width ?? 800) - width - 12
      const x = Math.max(12, Math.min(req.screen.x, maxX))
      const y = Math.max(12, Math.min(req.screen.y, (rect?.height ?? 600) - 268))
      setCtxMenu(null)
      setQuickCreate({ req, x, y })
    })
  }, [])

  // 点空白处关闭所有浮层
  useEffect(() => {
    if (!quickCreate && !ctxMenu) return
    const onDown = (ev: PointerEvent): void => {
      const el = ev.target instanceof Element ? ev.target : null
      if (el?.closest('.ivc-quickcreate,.ivc-ctxmenu')) return
      if (el?.closest('.ant-popover,.ant-dropdown,.ant-modal-root')) return
      closeQuickCreate()
      setCtxMenu(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [quickCreate, ctxMenu, closeQuickCreate])

  /** 键盘：守卫顺序照抄成熟画布实现 —— 输入框优先、Electron 防后退、Esc 层层退出 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target instanceof Element ? e.target : null
      const editing = !!el?.closest("input,textarea,select,[contenteditable='true']")
      const mod = e.ctrlKey || e.metaKey
      const key = e.key

      // Electron/webview 里未消费的 Backspace 会触发历史后退，直接离开画布路由
      if ((key === 'Backspace' || key === 'Delete') && !editing) e.preventDefault()

      // Esc：先关浮层，再清选择（各层互不阻塞）
      if (key === 'Escape') {
        if (quickCreate) {
          closeQuickCreate()
          return
        }
        if (ctxMenu) {
          setCtxMenu(null)
          return
        }
        if (viewSettingsOpen) {
          setViewSettingsOpen(false)
          return
        }
        const st = canvasStore.getState()
        if (st.selectedIds.length || st.selectedConnectionId) {
          canvasStore.setSelection([])
          canvasStore.selectConnection(null)
          return
        }
        if (chatOpen) setChatOpen(false)
        return
      }

      // 输入框里只放行撤销/重做，其余交给原生编辑
      if (editing) {
        if (mod && key.toLowerCase() === 'z') {
          e.preventDefault()
          if (e.shiftKey) redo()
          else undo()
        }
        return
      }
      // 弹窗打开时（快捷键等）裸键让位。
      // 注意不能只看 .ant-modal-root 是否存在：AntD 关闭后仍保留 portal 容器，会把快捷键永久吃掉。
      // 以 .ant-modal-wrap 的实际 display 判断「真的有弹窗在屏幕上」。
      if (!mod) {
        const wrap = document.querySelector<HTMLElement>('.ant-modal-wrap')
        if (wrap && getComputedStyle(wrap).display !== 'none') return
      }

      if (mod && key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if (mod && key.toLowerCase() === 'c') {
        e.preventDefault()
        canvasStore.copySelection()
        return
      }
      if (mod && key.toLowerCase() === 'v') {
        e.preventDefault()
        canvasStore.paste()
        return
      }
      if (mod && key.toLowerCase() === 'd') {
        e.preventDefault()
        canvasStore.duplicateSelection()
        return
      }
      if (mod && key.toLowerCase() === 'a') {
        e.preventDefault()
        canvasStore.setSelection(canvasStore.getState().nodeIds)
        return
      }
      // 视图导航（Ctrl/Cmd + 0/1/2/3）
      if (mod && (key === '0' || key === '1' || key === '2' || key === '3')) {
        e.preventDefault()
        if (key === '0' || key === '2') fitAll()
        else if (key === '1') resetZoom()
        else focusSelected()
        return
      }

      const st = canvasStore.getState()
      if (key === 'Delete' || key === 'Backspace') {
        // 连线优先：选中连线时 Delete 删连线，不连带删节点
        if (st.selectedConnectionId) canvasStore.removeConnection(st.selectedConnectionId)
        else if (st.selectedIds.length) for (const id of st.selectedIds) canvasStore.removeNode(id)
        return
      }
      // 方向键微移（Shift 加速 10px）
      if (key.startsWith('Arrow') && st.selectedIds.length) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0
        const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0
        const origins = st.selectedIds
          .map((id) => {
            const n = st.nodes.find((x) => x.id === id)
            return n ? { id: n.id, x: n.x, y: n.y } : null
          })
          .filter((o): o is { id: string; x: number; y: number } => !!o)
        canvasStore.moveNodes(origins, dx, dy)
        return
      }
      if (key === '+' || key === '=') {
        zoomAtCenter(1.2)
        return
      }
      if (key === '-' || key === '_') {
        zoomAtCenter(1 / 1.2)
        return
      }
      if (key === '0') {
        resetZoom()
        return
      }
      if (!mod && key === '?') {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
        return
      }
      if (!mod && (key === 'f' || key === 'F')) {
        e.preventDefault()
        if (e.shiftKey) focusSelected()
        else fitAll()
        return
      }
      if (!mod && (key === 'v' || key === 'V')) {
        setTool('select')
        return
      }
      if (!mod && (key === 'h' || key === 'H')) {
        setTool('pan')
        return
      }
      if (!mod && (key === 'n' || key === 'N')) {
        e.preventDefault()
        const size = canvasSize()
        requestQuickCreate({
          world: { x: (size.width / 2 - st.viewport.x) / st.viewport.k, y: (size.height / 2 - st.viewport.y) / st.viewport.k },
          screen: { x: size.width / 2, y: size.height / 2 },
          sourceNodeId: null,
          origin: 'shortcut'
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomAtCenter, fitAll, focusSelected, resetZoom, quickCreate, ctxMenu, viewSettingsOpen, chatOpen, closeQuickCreate])

  // 视口变化不重建节点元素：只有增删节点才重建（useMemo 依赖 nodeIds 引用）
  const nodeLayer = useMemo(() => ids.map((id) => <CanvasNodeHost key={id} id={id} />), [ids])

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <InfiniteCanvas
        containerRef={containerRef}
        viewport={viewport}
        tool={tool}
        onViewportChange={(vp) => {
          interruptNav()
          setViewport(vp)
        }}
        onCanvasMouseDown={startMarquee}
        onCanvasDeselect={() => {
          canvasStore.select(null)
          canvasStore.selectConnection(null)
          setCtxMenu(null)
        }}
        onCanvasDoubleClick={(e) => {
          const rect = containerRef.current?.getBoundingClientRect()
          const vp = canvasStore.getState().viewport
          const sx = e.clientX - (rect?.left ?? 0)
          const sy = e.clientY - (rect?.top ?? 0)
          requestQuickCreate({
            world: { x: (sx - vp.x) / vp.k, y: (sy - vp.y) / vp.k },
            screen: { x: sx, y: sy },
            sourceNodeId: null,
            origin: 'double-click'
          })
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          const el = e.target instanceof Element ? e.target : null
          const rect = containerRef.current?.getBoundingClientRect()
          const vp = canvasStore.getState().viewport
          const x = e.clientX - (rect?.left ?? 0)
          const y = e.clientY - (rect?.top ?? 0)
          setQuickCreate(null)
          setCtxMenu({
            x: Math.max(8, Math.min(x, (rect?.width ?? 800) - 216)),
            y: Math.max(8, Math.min(y, (rect?.height ?? 600) - 300)),
            worldX: (x - vp.x) / vp.k,
            worldY: (y - vp.y) / vp.k,
            nodeId: el?.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null
          })
        }}
      >
        <ConnectionLayer />
        <SnapGuideLayer />
        {nodeLayer}
      </InfiniteCanvas>

      <div className="ivc-marquee ivc-no-zoom" data-marquee="true" ref={marqueeRef} style={{ display: 'none' }} />

      {ids.length === 0 && (
        <div className="ivc-empty ivc-no-zoom" data-empty-canvas="true">
          <div className="ivc-empty-title">空白画布</div>
          <div className="ivc-empty-desc">
            从底部工具条新建节点，或直接把图片拖进来；也可以双击空白处、打开「对话」，让 AI 帮你搭流程。
          </div>
          <div className="ivc-empty-actions">
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => addAndReveal('text')}>
              新建文本
            </Button>
            <Button size="small" icon={<MessageOutlined />} onClick={() => setChatOpen(true)}>
              打开对话
            </Button>
            <Button size="small" type="text" onClick={() => setShortcutsOpen(true)}>
              快捷键
            </Button>
          </div>
        </div>
      )}

      {/* 左上：工具与全局操作 */}
      <div className="ivc-topbar ivc-no-zoom">
        <Tooltip title="选择 / 拖拽节点（V）">
          <Button size="small" type={tool === 'select' ? 'primary' : 'text'} icon={<DragOutlined />} onClick={() => setTool('select')} />
        </Tooltip>
        <Tooltip title="平移画布（H，或按住空格/中键）">
          <Button size="small" type={tool === 'pan' ? 'primary' : 'text'} icon={<EyeOutlined />} onClick={() => setTool('pan')} />
        </Tooltip>
        <span className="ivc-sep" />
        <Tooltip title="撤销（Ctrl+Z）">
          <Button size="small" type="text" icon={<UndoOutlined />} disabled={!undoable} onClick={() => undo()} data-undo="true" />
        </Tooltip>
        <Tooltip title="重做（Ctrl+Shift+Z）">
          <Button size="small" type="text" icon={<RedoOutlined />} disabled={!redoable} onClick={() => redo()} data-redo="true" />
        </Tooltip>
        <span className="ivc-sep" />
        <Tooltip title="计划对话（说需求 → 自动搭流程）">
          <Button size="small" type={chatOpen ? 'primary' : 'text'} icon={<MessageOutlined />} onClick={() => setChatOpen((v) => !v)}>
            对话
          </Button>
        </Tooltip>
        {onOpenCompose && (
          <Tooltip title="精修合成（图层拼合 / 抠图 / 导出）">
            <Button size="small" type="text" icon={<BlockOutlined />} onClick={onOpenCompose} data-open-compose="true">
              合成
            </Button>
          </Tooltip>
        )}
        <Tooltip title="快捷键（?）">
          <Button size="small" type="text" icon={<QuestionCircleOutlined />} onClick={() => setShortcutsOpen(true)} data-shortcuts="true" />
        </Tooltip>
      </div>

      {/* 下中：新建节点 */}
      <div className="ivc-toolbar ivc-no-zoom">
        {ADD_BUTTONS.map((b) => (
          <Tooltip key={b.type} title={b.hint}>
            <button className="ivc-tool" data-create-type={b.type} onClick={() => addAndReveal(b.type)}>
              <span className="ivc-tool-icon">{b.icon}</span>
              <span className="ivc-tool-label">{b.label}</span>
            </button>
          </Tooltip>
        ))}
      </div>

      {/* 右下：缩放与视图设置 */}
      <div className="ivc-zoomctrl ivc-no-zoom">
        <Button size="small" type="text" icon={<ZoomOutOutlined />} onClick={() => zoomAtCenter(1 / 1.2)} />
        <button className="ivc-zoom-label" onClick={resetZoom} title="点击回到 100%">
          {Math.round(viewport.k * 100)}%
        </button>
        <Button size="small" type="text" icon={<ZoomInOutlined />} onClick={() => zoomAtCenter(1.2)} />
        <span className="ivc-sep" />
        <Button size="small" type="text" onClick={fitAll} data-fit="true" title="适配全部节点（F）">
          适配
        </Button>
        <Popover
          open={viewSettingsOpen}
          onOpenChange={(v) => setViewSettingsOpen(v)}
          trigger="click"
          placement="topRight"
          content={
            <div className="ivc-viewsettings">
              <div className="ivc-viewsettings-row">
                <span>背景</span>
                <Segmented
                  size="small"
                  value={prefs.backgroundMode}
                  onChange={(v) => setCanvasPrefs({ backgroundMode: v as CanvasBackgroundMode })}
                  options={[
                    { label: '点阵', value: 'dots' },
                    { label: '线条', value: 'lines' },
                    { label: '空白', value: 'blank' }
                  ]}
                />
              </div>
              <div className="ivc-viewsettings-row">
                <span>滚轮</span>
                <Segmented
                  size="small"
                  value={prefs.wheelBehavior}
                  onChange={(v) => setCanvasPrefs({ wheelBehavior: v as CanvasPrefs['wheelBehavior'] })}
                  options={[
                    { label: '自动', value: 'auto' },
                    { label: '缩放', value: 'zoom' },
                    { label: '平移', value: 'pan' }
                  ]}
                />
              </div>
              <div className="ivc-viewsettings-row">
                <span>网格吸附</span>
                <Switch size="small" checked={prefs.snapToGrid} onChange={(v) => setCanvasPrefs({ snapToGrid: v })} />
              </div>
              <div className="ivc-viewsettings-hint">
                滚轮「自动」会区分鼠标滚轮与触控板：滚轮缩放、双指平移。手感不对就手动固定。
              </div>
            </div>
          }
        >
          <Button size="small" type="text" icon={<SettingOutlined />} data-view-settings="true" />
        </Popover>
      </div>

      {selection.length > 1 && (
        <div className="ivc-selbar ivc-no-zoom">
          <span className="ivc-selbar-count">已选 {selection.length}</span>
          <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => canvasStore.duplicateSelection()}>
            复制副本
          </Button>
          <Button size="small" type="text" icon={<ClearOutlined />} onClick={() => canvasStore.setSelection([])}>
            取消选择
          </Button>
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => {
              for (const id of canvasStore.getState().selectedIds) canvasStore.removeNode(id)
            }}
          >
            删除
          </Button>
        </div>
      )}

      {ctxMenu && (
        <div className="ivc-ctxmenu ivc-no-zoom" style={{ left: ctxMenu.x, top: ctxMenu.y }} onContextMenu={(e) => e.preventDefault()}>
          {ctxMenu.nodeId ? (
            <>
              <div className="ivc-menu-group">节点</div>
              <button
                onClick={() => {
                  canvasStore.select(ctxMenu.nodeId as string)
                  setCtxMenu(null)
                }}
              >
                <SearchOutlined /> 选中节点
              </button>
              <button
                onClick={() => {
                  canvasStore.select(ctxMenu.nodeId as string)
                  canvasStore.duplicateSelection()
                  setCtxMenu(null)
                }}
              >
                <CopyOutlined /> 复制副本 <kbd>Ctrl+D</kbd>
              </button>
              <div className="ivc-menu-divider" />
              <button
                className="ivc-menu-danger"
                onClick={() => {
                  canvasStore.removeNode(ctxMenu.nodeId as string)
                  setCtxMenu(null)
                }}
              >
                <DeleteOutlined /> 删除节点 <kbd>Del</kbd>
              </button>
            </>
          ) : (
            <>
              <div className="ivc-menu-group">在此新建</div>
              {ADD_BUTTONS.map((b) => (
                <button
                  key={b.type}
                  onClick={() => {
                    addAndReveal(b.type, { x: ctxMenu.worldX, y: ctxMenu.worldY })
                    setCtxMenu(null)
                  }}
                >
                  {b.icon} {b.label}
                </button>
              ))}
              <div className="ivc-menu-divider" />
              <button onClick={() => setCtxMenu(null)}>
                <CheckOutlined /> 关闭
              </button>
            </>
          )}
        </div>
      )}

      {quickCreate && (
        <div className="ivc-quickcreate ivc-no-zoom" style={{ left: quickCreate.x, top: quickCreate.y }} data-quick-create="true">
          <div className="ivc-quickcreate-head">{quickCreate.req.sourceNodeId ? '新建并自动连线' : '在此新建'}</div>
          <div className="ivc-quickcreate-grid">
            {ADD_BUTTONS.map((b) => (
              <button
                key={b.type}
                data-create-type={b.type}
                onClick={() => {
                  const req = quickCreate.req
                  closeQuickCreate()
                  revealNode(createNodeAt(b.type, req))
                }}
              >
                <span className="ivc-tool-icon">{b.icon}</span>
                <span className="ivc-tool-label">{b.label}</span>
              </button>
            ))}
          </div>
          <div className="ivc-quickcreate-foot">Esc 关闭</div>
        </div>
      )}

      <MiniMap
        onNavigate={(vp) => {
          interruptNav()
          setViewport(vp)
        }}
      />

      <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />

      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <MigrationOverlay />
    </div>
  )
}

/**
 * 吸附对齐线：拖动时显示。位置按 1/k 换算，保证缩放后仍是 1 屏幕像素宽。
 */
function SnapGuideLayer(): JSX.Element | null {
  const guides = useGuides()
  const viewport = useViewport()
  if (!guides.length) return null
  const k = viewport.k > 0 ? viewport.k : 1
  const rect = getCanvasRect()
  const worldLeft = -viewport.x / k
  const worldTop = -viewport.y / k
  const worldW = (rect.width || 1920) / k
  const worldH = (rect.height || 1080) / k
  const thin = Math.max(1 / k, 0.4)
  return (
    <>
      {guides.map((g, i) =>
        g.axis === 'x' ? (
          <div
            key={'gx' + i}
            className="ivc-guide"
            data-guide="x"
            style={{ left: g.world, top: worldTop, width: thin, height: worldH }}
          />
        ) : (
          <div
            key={'gy' + i}
            className="ivc-guide"
            data-guide="y"
            style={{ left: worldLeft, top: g.world, width: worldW, height: thin }}
          />
        )
      )}
    </>
  )
}

/**
 * 小地图：节点包围盒 + 视口框，点击/拖拽导航。
 * 包围盒用 useMemo 缓存（只在 nodes/viewport/尺寸变化时 O(N) 重算），
 * 容器尺寸走 rect-cache，渲染期不再读布局、也不再 document.querySelector。
 */
function MiniMap({ onNavigate }: { onNavigate: (vp: ViewportTransform) => void }): JSX.Element {
  useGeometryVersion()
  useNodeIds()
  const viewport = useViewport()
  const nodes = canvasStore.getState().nodes
  const W = 188
  const H = 128
  const rect = getCanvasRect()
  const vw = rect.width || 800
  const vh = rect.height || 600

  const view = useMemo(() => {
    if (nodes.length === 0) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of nodes) {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + n.width)
      maxY = Math.max(maxY, n.y + n.height)
    }
    const vp = viewport
    minX = Math.min(minX, -vp.x / vp.k)
    minY = Math.min(minY, -vp.y / vp.k)
    maxX = Math.max(maxX, (vw - vp.x) / vp.k)
    maxY = Math.max(maxY, (vh - vp.y) / vp.k)
    const pad = 80
    minX -= pad
    minY -= pad
    maxX += pad
    maxY += pad
    return { minX, minY, scale: Math.min(W / (maxX - minX), H / (maxY - minY)) }
  }, [nodes, viewport, vw, vh])

  if (!view) {
    return (
      <div className="ivc-minimap ivc-no-zoom" style={{ opacity: 0.55 }}>
        <div className="ivc-minimap-empty">空画布</div>
      </div>
    )
  }
  const { minX, minY, scale } = view
  const toMap = (x: number, y: number): [number, number] => [(x - minX) * scale, (y - minY) * scale]
  const [vx, vy] = toMap(-viewport.x / viewport.k, -viewport.y / viewport.k)
  const vwMap = (vw / viewport.k) * scale
  const vhMap = (vh / viewport.k) * scale

  return (
    <div
      className="ivc-minimap ivc-no-zoom"
      data-minimap="true"
      title="拖拽导航"
      onPointerDown={(e) => {
        e.preventDefault()
        const host = e.currentTarget
        const navigate = (cx: number, cy: number): void => {
          const r = host.getBoundingClientRect()
          const wx = (cx - r.left) / scale + minX
          const wy = (cy - r.top) / scale + minY
          const k = canvasStore.getState().viewport.k
          const size = getCanvasRect()
          onNavigate({ x: (size.width || 800) / 2 - wx * k, y: (size.height || 600) / 2 - wy * k, k })
        }
        navigate(e.clientX, e.clientY)
        const move = (ev: PointerEvent): void => navigate(ev.clientX, ev.clientY)
        const up = (): void => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
    >
      <svg width={W} height={H}>
        {nodes.map((n) => {
          const [x, y] = toMap(n.x, n.y)
          return (
            <rect
              key={n.id}
              x={x}
              y={y}
              width={Math.max(3, n.width * scale)}
              height={Math.max(2, n.height * scale)}
              rx={2}
              fill={
                n.type === 'image'
                  ? '#10b981'
                  : n.type === 'video'
                    ? '#f97316'
                    : n.type === 'generate'
                      ? '#60a5fa'
                      : '#94a3b8'
              }
              opacity={0.7}
            />
          )
        })}
        <rect className="ivc-minimap-view" x={vx} y={vy} width={Math.max(6, vwMap)} height={Math.max(6, vhMap)} rx={3} />
      </svg>
    </div>
  )
}

/**
 * 连线层：只覆盖「当前可见世界区域」的 SVG，取代原先 200000x200000 的超大世界 layer。
 *
 * 坐标空间：本层渲染在 .ivc-world 内部（父级已施加 translate+scale），因此这里一律用世界坐标。
 * 通过把 SVG 定位到当前视口对应的世界矩形、并用 <g> 平移回原点，避免 SVG 布局盒随缩放爆炸。
 */
function ConnectionLayer(): JSX.Element {
  // 几何变化才重算贝塞尔（节点内容/对话变化不触发）
  useGeometryVersion()
  const connections = useConnections()
  const viewport = useViewport()
  const selectedConnectionId = useSelectedConnection()
  const nodes = canvasStore.getState().nodes
  const [pendingActive, setPendingActive] = useState(() => Boolean(getPending()))
  const pathRef = useRef<SVGPathElement | null>(null)
  const dotRef = useRef<SVGCircleElement | null>(null)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const k = viewport.k > 0 ? viewport.k : 1
  const rect = getCanvasRect()
  const viewW = (rect.width || 1920) / k
  const viewH = (rect.height || 1080) / k
  const worldLeft = -viewport.x / k
  const worldTop = -viewport.y / k

  // pending 状态只在 begin/end 时通知（拖动过程直接改 DOM 属性，不触发重渲染）
  useEffect(() => subscribePending(() => setPendingActive(Boolean(getPending()))), [])

  useEffect(() => {
    registerPendingElements(pathRef.current, dotRef.current)
    return () => registerPendingElements(null, null)
  }, [pendingActive])

  return (
    <svg
      className="ivc-connections"
      style={{
        position: 'absolute',
        left: worldLeft,
        top: worldTop,
        width: viewW,
        height: viewH,
        pointerEvents: 'none',
        overflow: 'visible'
      }}
    >
      <g transform={'translate(' + -worldLeft + ' ' + -worldTop + ')'}>
        {connections.map((c) => {
          const a = byId.get(c.from)
          const b = byId.get(c.to)
          if (!a || !b) return null
          const mx = (a.x + a.width + b.x) / 2
          const y1 = a.y + a.height / 2
          const y2 = b.y + b.height / 2
          const d = 'M ' + (a.x + a.width) + ' ' + y1 + ' C ' + mx + ' ' + y1 + ', ' + mx + ' ' + y2 + ', ' + b.x + ' ' + y2
          const on = selectedConnectionId === c.id
          return (
            <g key={c.id} data-connection-id={c.id}>
              <path d={d} stroke={on ? '#0a5cc0' : '#0071e3'} strokeWidth={(on ? 3 : 2) / k} fill="none" opacity={on ? 1 : 0.7} />
              {/* 透明加粗命中带（16px 屏幕像素）：让连线成为可点/可选/可删的一等对象 */}
              <path
                d={d}
                stroke="transparent"
                strokeWidth={16 / k}
                fill="none"
                style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  canvasStore.selectConnection(c.id)
                }}
              />
            </g>
          )
        })}
        {pendingActive && (
          <>
            <path ref={pathRef} data-pending-line="1" stroke="#0071e3" strokeWidth={2 / k} strokeDasharray="6 4" fill="none" opacity={0.9} />
            <circle ref={dotRef} data-pending-dot="1" r={4 / k} fill="#0071e3" opacity={0.9} />
          </>
        )}
      </g>
    </svg>
  )
}