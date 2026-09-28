import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Stage, Layer, Image as KImage, Text as KText, Rect, Transformer } from 'react-konva'
import { App as AntdApp, Button, Card, Col, ColorPicker, Input, Menu, Popconfirm, Row, Select, Slider, Space, Tag, Tooltip, Typography, Upload } from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  BlockOutlined,
  CompressOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FileImageOutlined,
  RedoOutlined,
  ScanOutlined,
  UndoOutlined,
  ZoomInOutlined,
  ZoomOutOutlined
} from '@ant-design/icons'
import type { HistoryItem } from '../types'

interface CompLayer {
  id: string
  type: 'image' | 'text'
  name: string
  src?: string // image
  text?: string // text
  x: number
  y: number
  width: number
  height: number
  rotation: number
  opacity: number
  visible: boolean
  fontSize?: number
  fill?: string
}

interface Snapshot {
  layers: CompLayer[]
}

interface Props {
  visible: boolean
}

const CANVAS_PRESETS = [
  { value: '1024x1024', label: '方图 1:1 · 1024', w: 1024, h: 1024 },
  { value: '896x1152', label: '竖图 3:4 · 896×1152', w: 896, h: 1152 },
  { value: '1152x896', label: '横图 4:3 · 1152×896', w: 1152, h: 896 },
  { value: '768x1344', label: '竖屏 9:16 · 768×1344', w: 768, h: 1344 }
]

let uid = 0
const nextId = (): string => `L${++uid}`

/** 把 media:// / data:// 图片加载为 HTMLImageElement */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = src
  })
}

export default function ComposeView({ visible }: Props): JSX.Element {
  const { message } = AntdApp.useApp()
  const [canvasSize, setCanvasSize] = useState(CANVAS_PRESETS[0])
  const [layers, setLayers] = useState<CompLayer[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [images, setImages] = useState<Record<string, HTMLImageElement>>({})
  const [viewScale, setViewScale] = useState(0.5)
  const [busy, setBusy] = useState(false)
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([])
  const stageRef = useRef<any>(null)
  const trRef = useRef<any>(null)
  const undoStack = useRef<Snapshot[]>([])
  const redoStack = useRef<Snapshot[]>([])

  useEffect(() => {
    if (visible) void window.api.history().then(setHistoryItems).catch(() => undefined)
  }, [visible])

  // ---------- 撤销/重做 ----------
  const pushHistory = useCallback(
    (snapshotLayers: CompLayer[]): void => {
      undoStack.current.push({ layers: JSON.parse(JSON.stringify(snapshotLayers)) })
      if (undoStack.current.length > 50) undoStack.current.shift()
      redoStack.current = []
    },
    []
  )

  const applySnapshot = (snap: Snapshot): void => {
    setLayers(snap.layers)
  }

  const undo = useCallback((): void => {
    if (undoStack.current.length === 0) return
    const cur: Snapshot = { layers: JSON.parse(JSON.stringify(layers)) }
    redoStack.current.push(cur)
    const prev = undoStack.current.pop()!
    applySnapshot(prev)
    setSelected(null)
  }, [layers])

  const redo = useCallback((): void => {
    if (redoStack.current.length === 0) return
    const cur: Snapshot = { layers: JSON.parse(JSON.stringify(layers)) }
    undoStack.current.push(cur)
    const nxt = redoStack.current.pop()!
    applySnapshot(nxt)
    setSelected(null)
  }, [layers])

  useEffect(() => {
    if (!visible) return
    function onKey(e: KeyboardEvent): void {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((e.key.toLowerCase() === 'y') || (e.key.toLowerCase() === 'z' && e.shiftKey)) {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, undo, redo])

  // ---------- 图层操作 ----------
  function commit(next: CompLayer[]): void {
    pushHistory(layers)
    setLayers(next)
  }

  async function addImage(src: string, name: string): Promise<void> {
    try {
      const img = await loadImage(src)
      const scale = Math.min(1, (canvasSize.w * 0.6) / img.width, (canvasSize.h * 0.6) / img.height)
      const layer: CompLayer = {
        id: nextId(),
        type: 'image',
        name,
        src,
        x: (canvasSize.w - img.width * scale) / 2,
        y: (canvasSize.h - img.height * scale) / 2,
        width: img.width * scale,
        height: img.height * scale,
        rotation: 0,
        opacity: 1,
        visible: true
      }
      setImages((m) => ({ ...m, [src]: img }))
      commit([...layers, layer])
      setSelected(layer.id)
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    }
  }

  function addText(): void {
    const layer: CompLayer = {
      id: nextId(),
      type: 'text',
      name: '文字',
      text: '双击右侧编辑文案',
      x: canvasSize.w * 0.15,
      y: canvasSize.h * 0.42,
      width: canvasSize.w * 0.7,
      height: 48,
      rotation: 0,
      opacity: 1,
      visible: true,
      fontSize: 64,
      fill: '#1d1d1f'
    }
    commit([...layers, layer])
    setSelected(layer.id)
  }

  function removeSelected(): void {
    if (!selected) return
    commit(layers.filter((l) => l.id !== selected))
    setSelected(null)
  }

  function moveLayer(id: string, dir: -1 | 1): void {
    const idx = layers.findIndex((l) => l.id === id)
    const to = idx + dir
    if (to < 0 || to >= layers.length) return
    const next = [...layers]
    const [it] = next.splice(idx, 1)
    next.splice(to, 0, it)
    commit(next)
  }

  function updateLayer(id: string, patch: Partial<CompLayer>, history = false): void {
    const next = layers.map((l) => (l.id === id ? { ...l, ...patch } : l))
    if (history) commit(next)
    else setLayers(next)
  }

  // 滑条/取色器：一次连续拖动只记一条撤销历史（首次变更入栈，结束时复位）
  const dragging = useRef(false)
  function liveUpdate(id: string, patch: Partial<CompLayer>): void {
    if (!dragging.current) {
      dragging.current = true
      updateLayer(id, patch, true)
    } else {
      updateLayer(id, patch)
    }
  }
  function endLiveUpdate(): void {
    dragging.current = false
  }

  const selectedLayer = layers.find((l) => l.id === selected) ?? null
  const [pickMode, setPickMode] = useState(false)
  const [pickPoints, setPickPoints] = useState<Array<{ x: number; y: number }>>([])
  const [segMaskUrl, setSegMaskUrl] = useState<string | null>(null)
  const [segBusy, setSegBusy] = useState(false)
  const pickTarget = pickMode && selectedLayer?.type === 'image' ? selectedLayer : null

  // 掩码图载入缓存供 Konva 渲染
  useEffect(() => {
    if (segMaskUrl && !images[segMaskUrl]) {
      void loadImage(segMaskUrl)
        .then((img) => setImages((m) => ({ ...m, [segMaskUrl]: img })))
        .catch(() => undefined)
    }
  }, [segMaskUrl, images])

  function exitPick(): void {
    setPickMode(false)
    setPickPoints([])
    setSegMaskUrl(null)
  }

  async function extractCutout(): Promise<void> {
    if (!pickTarget?.src || !segMaskUrl) return
    const imgEl = images[pickTarget.src]
    if (!imgEl) return
    const natW = imgEl.naturalWidth || pickTarget.width
    const natH = imgEl.naturalHeight || pickTarget.height
    const c = document.createElement('canvas')
    c.width = natW
    c.height = natH
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.drawImage(imgEl, 0, 0, natW, natH)
    const mask = images[segMaskUrl]
    if (mask) {
      ctx.globalCompositeOperation = 'destination-in'
      ctx.drawImage(mask, 0, 0, natW, natH)
      ctx.globalCompositeOperation = 'source-over'
    }
    const data = ctx.getImageData(0, 0, natW, natH).data
    let minX = natW
    let minY = natH
    let maxX = 0
    let maxY = 0
    for (let y = 0; y < natH; y++) {
      for (let x = 0; x < natW; x++) {
        if (data[(y * natW + x) * 4 + 3] > 10) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX <= minX || maxY <= minY) {
      message.warning('没抠到内容，多点几个点试试')
      return
    }
    const w = maxX - minX + 1
    const h = maxY - minY + 1
    const c2 = document.createElement('canvas')
    c2.width = w
    c2.height = h
    c2.getContext('2d')?.drawImage(c, minX, minY, w, h, 0, 0, w, h)
    const url = c2.toDataURL('image/png')
    const scale = pickTarget.width / natW
    const layer: CompLayer = {
      id: nextId(),
      type: 'image',
      name: '抠图',
      src: url,
      x: pickTarget.x + minX * scale,
      y: pickTarget.y + minY * scale,
      width: w * scale,
      height: h * scale,
      rotation: 0,
      opacity: 1,
      visible: true
    }
    const img = await loadImage(url)
    setImages((m) => ({ ...m, [url]: img }))
    commit([...layers, layer])
    setSelected(layer.id)
    exitPick()
    message.success('已提取为新图层')
  }

  // 选中 → Transformer
  useEffect(() => {
    const tr = trRef.current
    if (!tr) return
    const node = selected ? stageRef.current?.findOne(`#${selected}`) : null
    tr.nodes(node ? [node] : [])
    tr.getLayer()?.batchDraw()
  }, [selected, layers])

  // ---------- 导出 ----------
  async function exportPng(): Promise<void> {
    const stage = stageRef.current
    if (!stage) return
    if (layers.length === 0) {
      message.warning('画布是空的，先添加图片或文字')
      return
    }
    setBusy(true)
    try {
      setSelected(null)
      await new Promise((r) => setTimeout(r, 60))
      const dataUrl = stage.toDataURL({ pixelRatio: 1 / viewScale })
      const r = await window.api.composeSave({ dataUrl, width: canvasSize.w, height: canvasSize.h })
      message.success(`已导出到作品目录：${r.name}`)
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // ---------- 从历史添加 ----------
  const historyOptions = useMemo(
    () => historyItems.slice(0, 60).map((h) => ({ value: h.url, label: h.name })),
    [historyItems]
  )

  return (
    <Row gutter={16}>
      {/* 左：图层与素材 */}
      <Col flex="330px">
        <Card title="画布" size="small" styles={{ body: { padding: 12 } }}>
          <Select
            value={canvasSize.value}
            onChange={(v) => setCanvasSize(CANVAS_PRESETS.find((p) => p.value === v) ?? CANVAS_PRESETS[0])}
            options={CANVAS_PRESETS}
            style={{ width: '100%' }}
          />
          <Space direction="vertical" style={{ width: '100%', marginTop: 10 }} size={6}>
            <Select
              showSearch
              placeholder="从作品目录添加图片…"
              options={historyOptions}
              filterOption={(input, o) => String(o?.label ?? '').toLowerCase().includes(input.toLowerCase())}
              onChange={(v) => {
                void addImage(String(v), historyItems.find((h) => h.url === v)?.name ?? '作品图片')
              }}
              notFoundContent="作品目录为空"
            />
            <Space wrap>
              <Upload
                accept="image/*"
                maxCount={1}
                showUploadList={false}
                beforeUpload={(f) => {
                  const reader = new FileReader()
                  reader.onload = () => void addImage(String(reader.result), f.name)
                  reader.onerror = () => message.error('读取失败')
                  reader.readAsDataURL(f)
                  return false
                }}
              >
                <Button icon={<FileImageOutlined />}>本地图片</Button>
              </Upload>
              <Button icon={<BlockOutlined />} onClick={addText}>
                文字
              </Button>
            </Space>
          </Space>
        </Card>

        <Card
          title="图层"
          size="small"
          styles={{ body: { padding: 8 } }}
          style={{ marginTop: 14 }}
          extra={
            selected && (
              <Space size={2}>
                <Tooltip title="上移一层">
                  <Button type="text" size="small" icon={<ArrowUpOutlined />} onClick={() => moveLayer(selected, 1)} />
                </Tooltip>
                <Tooltip title="下移一层">
                  <Button type="text" size="small" icon={<ArrowDownOutlined />} onClick={() => moveLayer(selected, -1)} />
                </Tooltip>
                <Popconfirm title="删除该图层？" okText="删除" onConfirm={removeSelected}>
                  <Button type="text" size="small" icon={<DeleteOutlined />} danger />
                </Popconfirm>
              </Space>
            )
          }
        >
          {layers.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              图层从上往下排列，先加的在底层
            </Typography.Text>
          ) : (
            <Menu
              mode="inline"
              className="layer-menu"
              selectedKeys={selected ? [selected] : []}
              onClick={({ key }) => setSelected(key)}
              items={[...layers].reverse().map((l) => ({
                key: l.id,
                label: (
                  <span className="layer-row">
                    <span className="layer-name">{l.type === 'text' ? `T ${l.name}` : l.name}</span>
                    <Button
                      type="text"
                      size="small"
                      icon={l.visible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                      onClick={(e) => {
                        e.stopPropagation()
                        updateLayer(l.id, { visible: !l.visible }, true)
                      }}
                    />
                  </span>
                )
              }))}
            />
          )}
        </Card>

        {selectedLayer && (
          <Card title="图层属性" size="small" styles={{ body: { padding: 12 } }} style={{ marginTop: 14 }}>
            {selectedLayer.type === 'text' && (
              <>
                <Typography.Text className="field-label">文案</Typography.Text>
                <Input
                  value={selectedLayer.text ?? ''}
                  onChange={(e) => updateLayer(selectedLayer.id, { text: e.target.value })}
                  placeholder="输入文字内容"
                />
                <Typography.Text className="field-label">字号 · {selectedLayer.fontSize ?? 64}</Typography.Text>
                <Slider
                  min={16}
                  max={240}
                  value={selectedLayer.fontSize ?? 64}
                  onChange={(v) => liveUpdate(selectedLayer.id, { fontSize: v })}
                  onChangeComplete={endLiveUpdate}
                />
                <Typography.Text className="field-label">颜色</Typography.Text>
                <ColorPicker
                  value={selectedLayer.fill ?? '#1d1d1f'}
                  onChange={(c) => liveUpdate(selectedLayer.id, { fill: c.toHexString() })}
                  onChangeComplete={endLiveUpdate}
                  showText
                />
              </>
            )}
            <Typography.Text className="field-label">透明度 · {Math.round(selectedLayer.opacity * 100)}%</Typography.Text>
            <Slider
              min={5}
              max={100}
              value={Math.round(selectedLayer.opacity * 100)}
              onChange={(v) => liveUpdate(selectedLayer.id, { opacity: v / 100 })}
              onChangeComplete={endLiveUpdate}
            />
            <Typography.Text className="field-label">旋转 · {Math.round(selectedLayer.rotation)}°</Typography.Text>
            <Slider
              min={-180}
              max={180}
              value={Math.round(selectedLayer.rotation)}
              onChange={(v) => liveUpdate(selectedLayer.id, { rotation: v })}
              onChangeComplete={endLiveUpdate}
            />
          </Card>
        )}
      </Col>

      {/* 右：画布 */}
      <Col flex="auto" className="create-main">
        <Card
          styles={{ body: { padding: 12, height: '100%', display: 'flex', flexDirection: 'column' } }}
          className="result-card"
        >
          <div className="compose-toolbar">
            <Space size={6}>
              <Tooltip title="撤销 (Ctrl+Z)">
                <Button size="small" icon={<UndoOutlined />} onClick={undo} />
              </Tooltip>
              <Tooltip title="重做 (Ctrl+Y)">
                <Button size="small" icon={<RedoOutlined />} onClick={redo} />
              </Tooltip>
            </Space>
            <div className="toolbar-spacer" />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              显示 {Math.round(viewScale * 100)}% · 导出 {canvasSize.w}×{canvasSize.h}
            </Typography.Text>
            <Space size={6}>
              <Tooltip title="放大">
                <Button size="small" type="text" icon={<ZoomInOutlined />} onClick={() => setViewScale((v) => Math.min(1.5, v + 0.1))} />
              </Tooltip>
              <Tooltip title="缩小">
                <Button size="small" type="text" icon={<ZoomOutOutlined />} onClick={() => setViewScale((v) => Math.max(0.15, v - 0.1))} />
              </Tooltip>
              <Tooltip title="适配窗口">
                <Button size="small" type="text" icon={<CompressOutlined />} onClick={() => setViewScale(0.5)} />
              </Tooltip>
            </Space>
            {pickMode ? (
              <>
                <Tag color="processing" style={{ margin: 0 }}>
                  点击图上物体（{pickPoints.length} 点）
                </Tag>
                <Button size="small" type="primary" loading={segBusy} disabled={!segMaskUrl || pickPoints.length === 0} onClick={() => void extractCutout()}>
                  提取为图层
                </Button>
                <Button size="small" onClick={exitPick}>
                  退出
                </Button>
              </>
            ) : (
              <Tooltip title="点选物体，智能抠成新图层">
                <Button
                  size="small"
                  icon={<ScanOutlined />}
                  disabled={!(selectedLayer?.type === 'image')}
                  onClick={() => {
                    setPickPoints([])
                    setSegMaskUrl(null)
                    setPickMode(true)
                  }}
                >
                  智能抠图
                </Button>
              </Tooltip>
            )}
            <Button type="primary" size="small" icon={<DownloadOutlined />} loading={busy} onClick={exportPng}>
              导出 PNG
            </Button>
          </div>
          <div className="compose-stage-wrap">
            <Stage
              ref={stageRef}
              width={canvasSize.w * viewScale}
              height={canvasSize.h * viewScale}
              scaleX={viewScale}
              scaleY={viewScale}
              style={{ background: '#fff', borderRadius: 10, boxShadow: '0 6px 24px rgba(0,0,0,0.1)', cursor: pickMode ? 'crosshair' : 'default' }}
              onMouseDown={(e) => {
                const stage = e.target.getStage()
                if (pickMode) {
                  if (!pickTarget) return
                  const pos = stage?.getPointerPosition()
                  if (!pos || !pickTarget.src) return
                  const imgEl = images[pickTarget.src]
                  const natW = imgEl?.naturalWidth || pickTarget.width
                  const natH = imgEl?.naturalHeight || pickTarget.height
                  const sx = viewScale
                  const localX = ((pos.x - pickTarget.x * sx) / sx) * (natW / pickTarget.width)
                  const localY = ((pos.y - pickTarget.y * sx) / sx) * (natH / pickTarget.height)
                  const pts = [...pickPoints, { x: localX, y: localY }]
                  setPickPoints(pts)
                  setSegBusy(true)
                  void window.api
                    .segmentMask(pickTarget.src, pts)
                    .then((r) => setSegMaskUrl(r.maskUrl))
                    .catch((er) => message.error(`分割失败：${er.message ?? er}`))
                    .finally(() => setSegBusy(false))
                  return
                }
                if (e.target === e.target.getStage()) setSelected(null)
              }}
            >
              <Layer>
                <Rect x={0} y={0} width={canvasSize.w} height={canvasSize.h} fill="#ffffff" />
                {layers
                  .filter((l) => l.visible && (l.type !== 'image' || images[l.src ?? '']))
                  .map((l) =>
                    l.type === 'image' ? (
                      <KImage
                        key={l.id}
                        id={l.id}
                        image={images[l.src ?? '']}
                        x={l.x}
                        y={l.y}
                        width={l.width}
                        height={l.height}
                        rotation={l.rotation}
                        opacity={l.opacity}
                        draggable
                        onClick={() => setSelected(l.id)}
                        onTap={() => setSelected(l.id)}
                        onDragEnd={(e) => updateLayer(l.id, { x: e.target.x(), y: e.target.y() }, true)}
                        onTransformEnd={(e) => {
                          const node = e.target
                          updateLayer(
                            l.id,
                            {
                              x: node.x(),
                              y: node.y(),
                              width: Math.max(20, node.width() * node.scaleX()),
                              height: Math.max(20, node.height() * node.scaleY()),
                              rotation: node.rotation()
                            },
                            true
                          )
                          node.scaleX(1)
                          node.scaleY(1)
                        }}
                      />
                    ) : (
                      <KText
                        key={l.id}
                        id={l.id}
                        text={l.text ?? ''}
                        x={l.x}
                        y={l.y}
                        width={l.width}
                        fontSize={l.fontSize ?? 64}
                        fontFamily="PingFang SC, Microsoft YaHei, sans-serif"
                        fontStyle="bold"
                        fill={l.fill ?? '#1d1d1f'}
                        opacity={l.opacity}
                        rotation={l.rotation}
                        draggable
                        onClick={() => setSelected(l.id)}
                        onDragEnd={(e) => updateLayer(l.id, { x: e.target.x(), y: e.target.y() }, true)}
                        onTransformEnd={(e) => {
                          const node = e.target
                          updateLayer(l.id, { x: node.x(), y: node.y(), rotation: node.rotation() }, true)
                        }}
                      />
                    )
                  )}
                  {pickMode && segMaskUrl && pickTarget && images[segMaskUrl] && (
                    <KImage
                      image={images[segMaskUrl]}
                      x={pickTarget.x}
                      y={pickTarget.y}
                      width={pickTarget.width}
                      height={pickTarget.height}
                      opacity={0.55}
                      listening={false}
                    />
                  )}
                <Transformer ref={trRef} rotateEnabled keepRatio={false} borderStroke="#0071e3" anchorStroke="#0071e3" anchorFill="#ffffff" anchorSize={9} />
              </Layer>
            </Stage>
          </div>
        </Card>
      </Col>
    </Row>
  )
}
