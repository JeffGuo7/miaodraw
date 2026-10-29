/**
 * 画布工作台 — miaodraw 画布模式一级视图
 * 引擎/节点移植自 basketikun/infinite-canvas（MIT），见各文件头署名。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Button, Progress, Tooltip } from 'antd'
import {
  BgColorsOutlined,
  FileTextOutlined,
  FileImageOutlined,
  PlayCircleOutlined,
  SoundOutlined,
  SettingOutlined,
  GroupOutlined,
  DragOutlined,
  MessageOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'

import { InfiniteCanvas } from './InfiniteCanvas'
import { CanvasNode } from './CanvasNode'
import { canvasStore, useCanvasState } from './store'
import { getPending, registerPendingElements, subscribePending } from './pending-connection'
import { attachPlanPersistence, loadAllPlans, loadPlan } from './plan-persistence'
import { getCanvasRect } from './rect-cache'
import { attachVideoJobPersistence } from './video-persistence'
import ChatPanel from './ChatPanel'
import { countAssets } from './db'
import { runMigration, type MigrationProgress } from './migrate'
import type { CanvasNodeType, ViewportTransform } from './types'
import type { PlanRecord, StageRecord } from '../../../shared/plan-types'
import './canvas.css'

const ADD_BUTTONS: Array<{ type: CanvasNodeType; icon: JSX.Element; label: string }> = [
  { type: 'generate', icon: <ThunderboltOutlined />, label: '出图' },
  { type: 'text', icon: <FileTextOutlined />, label: '文本' },
  { type: 'image', icon: <FileImageOutlined />, label: '图片' },
  { type: 'video', icon: <PlayCircleOutlined />, label: '视频' },
  { type: 'audio', icon: <SoundOutlined />, label: '音频' },
  { type: 'config', icon: <SettingOutlined />, label: '配置' },
  { type: 'group', icon: <GroupOutlined />, label: '分组' }
]

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
  if (!progress) return null
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : progress.phase === 'scanning' ? 0 : 100
  return (
    <div className="ivc-migration-mask ivc-no-zoom">
      <div className="ivc-migration-card">
        <div style={{ marginBottom: 8 }}>
          {progress.phase === 'scanning' ? '扫描历史作品…' : '正在建立画布资产索引（原文件不动，只建目录）'}
          {assetCount != null && ` · 现有 ${assetCount} 条`}
        </div>
        <Progress percent={pct} size="small" />
        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>
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
  const id = canvasStore.addNode('plan', { x: 24 + (count % 3) * 460, y: 24 + Math.floor(count / 3) * 420 })
  canvasStore.updateNode(id, { metadata: { planId } })
}

export default function CanvasWorkbench(): JSX.Element {
  const state = useCanvasState()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [tool, setTool] = useState<'select' | 'pan'>('select')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; worldX: number; worldY: number; nodeId: string | null } | null>(null)
  const [chatOpen, setChatOpen] = useState(false)

  const setViewport = useCallback((vp: ViewportTransform): void => {
    canvasStore.setViewport(vp)
  }, [])

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
        if (res?.restored) console.info(`[canvas] 重启续跑：恢复 ${res.restored} 个计划（跳过 ${res.skipped ?? 0}）`)
      } catch (e) {
        console.warn('[canvas] 计划恢复失败：', e instanceof Error ? e.message : e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const zoomBy = useCallback(
    (factor: number): void => {
      const vp = canvasStore.getState().viewport
      const k = Math.min(Math.max(vp.k * factor, 0.05), 5)
      // 以视口中心为缩放锚点
      const el = containerRef.current
      const cx = (el ? el.clientWidth / 2 : 400) - vp.x
      const cy = (el ? el.clientHeight / 2 : 300) - vp.y
      const wx = cx / vp.k
      const wy = cy / vp.k
      canvasStore.setViewport({ x: cx - wx * k, y: cy - wy * k, k })
    },
    []
  )

  // ── 快捷键：Delete 删除选中节点；+/- 缩放；0 复位 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target instanceof Element ? e.target : null
      if (el?.closest("input,textarea,select,[contenteditable='true']")) return
      const st = canvasStore.getState()
      const selectedNode = st.selectedIds[0]
      const selectedConn = st.selectedConnectionId
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedNode || selectedConn)) {
        e.preventDefault()
        if (selectedNode) canvasStore.removeNode(selectedNode)
        else if (selectedConn) canvasStore.removeConnection(selectedConn)
      } else if (e.key === '+' || e.key === '=') {
        zoomBy(1.2)
      } else if (e.key === '-' || e.key === '_') {
        zoomBy(1 / 1.2)
      } else if (e.key === '0') {
        canvasStore.setViewport({ x: 80, y: 80, k: 1 })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomBy])

  const resetView = useCallback((): void => {
    canvasStore.setViewport({ x: 80, y: 80, k: 1 })
  }, [])

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <InfiniteCanvas
        containerRef={containerRef}
        viewport={state.viewport}
        tool={tool}
        onViewportChange={setViewport}
        onCanvasDeselect={() => {
          canvasStore.select(null)
          canvasStore.selectConnection(null)
          setCtxMenu(null)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          const el = e.target instanceof Element ? e.target : null
          const rect = containerRef.current?.getBoundingClientRect()
          const vp = canvasStore.getState().viewport
          setCtxMenu({
            x: e.clientX - (rect?.left ?? 0),
            y: e.clientY - (rect?.top ?? 0),
            worldX: (e.clientX - (rect?.left ?? 0) - vp.x) / vp.k,
            worldY: (e.clientY - (rect?.top ?? 0) - vp.y) / vp.k,
            nodeId: el?.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null
          })
        }}
      >
        <ConnectionLayer />
        {state.nodes.map((n) => (
          <CanvasNode key={n.id} node={n} selected={state.selectedIds.includes(n.id)} />
        ))}
      </InfiniteCanvas>

      <div className="ivc-toolbar ivc-no-zoom">
        <Tooltip title="选择 / 拖拽节点">
          <Button size="small" type={tool === 'select' ? 'primary' : 'default'} icon={<DragOutlined />} onClick={() => setTool('select')} />
        </Tooltip>
        <Tooltip title="平移画布（或按住空格/Ctrl 临时平移）">
          <Button size="small" type={tool === 'pan' ? 'primary' : 'default'} icon={<BgColorsOutlined />} onClick={() => setTool('pan')} />
        </Tooltip>
        <span style={{ width: 1, height: 16, background: '#e2e6ee', display: 'inline-block' }} />
        <Tooltip title="计划对话（说需求 → 自动搭流程）">
          <Button size="small" type={chatOpen ? 'primary' : 'default'} icon={<MessageOutlined />} onClick={() => setChatOpen((v) => !v)}>
            对话
          </Button>
        </Tooltip>
        {ADD_BUTTONS.map((b) => (
          <Button key={b.type} size="small" icon={b.icon} onClick={() => canvasStore.addNode(b.type)}>
            {b.label}
          </Button>
        ))}
      </div>

      <div className="ivc-zoomctrl ivc-no-zoom">
        <Button size="small" type="text" onClick={() => zoomBy(1 / 1.2)}>−</Button>
        <span style={{ minWidth: 44, textAlign: 'center' }}>{Math.round(state.viewport.k * 100)}%</span>
        <Button size="small" type="text" onClick={() => zoomBy(1.2)}>＋</Button>
        <Button size="small" type="text" onClick={resetView}>复位</Button>
      </div>

      {ctxMenu && (
        <div className="ivc-ctxmenu ivc-no-zoom" style={{ left: ctxMenu.x, top: ctxMenu.y }} onContextMenu={(e) => e.preventDefault()}>
          {ctxMenu.nodeId ? (
            <>
              <button
                onClick={() => {
                  canvasStore.removeNode(ctxMenu.nodeId as string)
                  setCtxMenu(null)
                }}
              >
                删除节点
              </button>
              <button
                onClick={() => {
                  canvasStore.select(ctxMenu.nodeId)
                  setCtxMenu(null)
                }}
              >
                选中节点
              </button>
            </>
          ) : (
            ADD_BUTTONS.map((b) => (
              <button
                key={b.type}
                onClick={() => {
                  canvasStore.addNode(b.type, { x: ctxMenu.worldX, y: ctxMenu.worldY })
                  setCtxMenu(null)
                }}
              >
                新建：{b.label}
              </button>
            ))
          )}
          <button onClick={() => setCtxMenu(null)}>关闭</button>
        </div>
      )}

      <MiniMap />

      <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} />

      <MigrationOverlay />
    </div>
  )
}

/**
 * 小地图：节点包围盒 + 视口框，点击跳转。
 * 包围盒用 useMemo 缓存（只在 nodes/viewport/尺寸变化时 O(N) 重算），
 * 容器尺寸走 rect-cache，渲染期不再读布局、也不再 document.querySelector。
 */
function MiniMap(): JSX.Element {
  const state = useCanvasState()
  const W = 168
  const H = 112
  const rect = getCanvasRect()
  const vw = rect.width || 800
  const vh = rect.height || 600
  const view = useMemo(() => {
    if (state.nodes.length === 0) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of state.nodes) {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + n.width)
      maxY = Math.max(maxY, n.y + n.height)
    }
    const vp = state.viewport
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
  }, [state.nodes, state.viewport, vw, vh])

  if (!view) {
    return (
      <div className="ivc-minimap ivc-no-zoom" style={{ opacity: 0.5 }}>
        <div style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center' }}>空画布</div>
      </div>
    )
  }
  const { minX, minY, scale } = view
  const toMap = (x: number, y: number): [number, number] => [(x - minX) * scale, (y - minY) * scale]

  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const wx = (e.clientX - r.left) / scale + minX
    const wy = (e.clientY - r.top) / scale + minY
    const k = canvasStore.getState().viewport.k
    const size = getCanvasRect()
    canvasStore.setViewport({ x: (size.width || 800) / 2 - wx * k, y: (size.height || 600) / 2 - wy * k, k })
  }

  return (
    <div className="ivc-minimap ivc-no-zoom" onClick={onClick}>
      <svg width={W} height={H}>
        {state.nodes.map((n) => {
          const [x, y] = toMap(n.x, n.y)
          return (
            <rect
              key={n.id}
              x={x}
              y={y}
              width={Math.max(4, n.width * scale)}
              height={Math.max(3, n.height * scale)}
              rx={2}
              fill={n.type === 'image' ? '#10b981' : n.type === 'video' ? '#f97316' : n.type === 'generate' ? '#60a5fa' : '#94a3b8'}
              opacity={0.75}
            />
          )
        })}
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
  const { nodes, connections, viewport, selectedConnectionId } = useCanvasState()
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
      <g transform={`translate(${-worldLeft} ${-worldTop})`}>
        {connections.map((c) => {
          const a = byId.get(c.from)
          const b = byId.get(c.to)
          if (!a || !b) return null
          const mx = (a.x + a.width + b.x) / 2
          const d = `M ${a.x + a.width} ${a.y + a.height / 2} C ${mx} ${a.y + a.height / 2}, ${mx} ${b.y + b.height / 2}, ${b.x} ${b.y + b.height / 2}`
          const on = selectedConnectionId === c.id
          return (
            <g key={c.id}>
              <path d={d} stroke={on ? '#1677ff' : '#4096ff'} strokeWidth={(on ? 3 : 2) / k} fill="none" opacity={on ? 1 : 0.7} />
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
            <path ref={pathRef} data-pending-line="1" stroke="#4096ff" strokeWidth={2 / k} strokeDasharray="6 4" fill="none" opacity={0.9} />
            <circle ref={dotRef} data-pending-dot="1" r={4 / k} fill="#4096ff" opacity={0.9} />
          </>
        )}
      </g>
    </svg>
  )
}