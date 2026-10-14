/**
 * 画布工作台 — miaodraw 画布模式一级视图
 * 引擎/节点移植自 basketikun/infinite-canvas（MIT），见各文件头署名。
 */
import { useCallback, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Button, Tooltip } from 'antd'
import {
  BgColorsOutlined,
  FileTextOutlined,
  FileImageOutlined,
  PlayCircleOutlined,
  SoundOutlined,
  SettingOutlined,
  GroupOutlined,
  DragOutlined
} from '@ant-design/icons'

import { InfiniteCanvas } from './InfiniteCanvas'
import { CanvasNode } from './CanvasNode'
import { canvasStore, useCanvasState } from './store'
import type { CanvasNodeType, ViewportTransform } from './types'
import './canvas.css'

const ADD_BUTTONS: Array<{ type: CanvasNodeType; icon: JSX.Element; label: string }> = [
  { type: 'text', icon: <FileTextOutlined />, label: '文本' },
  { type: 'image', icon: <FileImageOutlined />, label: '图片' },
  { type: 'video', icon: <PlayCircleOutlined />, label: '视频' },
  { type: 'audio', icon: <SoundOutlined />, label: '音频' },
  { type: 'config', icon: <SettingOutlined />, label: '配置' },
  { type: 'group', icon: <GroupOutlined />, label: '分组' }
]

export default function CanvasWorkbench(): JSX.Element {
  const state = useCanvasState()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [tool, setTool] = useState<'select' | 'pan'>('select')

  const setViewport = useCallback((vp: ViewportTransform): void => {
    canvasStore.setViewport(vp)
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
        onCanvasDeselect={() => canvasStore.select(null)}
      >
        {state.nodes.map((n) => (
          <CanvasNode key={n.id} node={n} selected={state.selectedIds.includes(n.id)} scale={state.viewport.k} />
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
    </div>
  )
}
