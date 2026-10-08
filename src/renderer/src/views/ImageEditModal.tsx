import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App as AntdApp, Button, Modal, Segmented, Select, Slider, Space, Tooltip, Typography } from 'antd'
import { ClearOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { GenResult, ImageEditOp } from '../types'

interface Props {
  open: boolean
  /** 源图（media:// URL） */
  src: string | null
  /** 源图在作品目录里的文件名（用于 sidecar parent 与链式版本） */
  name?: string
  onClose: () => void
  onDone: (r: GenResult, op: ImageEditOp) => void
}

interface OpDef {
  value: ImageEditOp
  label: string
  needMask: boolean
  needPrompt: boolean
  hint: string
}

const OPS: OpDef[] = [
  { value: 'repaint', label: '局部重绘', needMask: true, needPrompt: true, hint: '涂抹要重画的地方，写清想画成什么' },
  { value: 'erase', label: '擦除物体', needMask: true, needPrompt: false, hint: '涂抹要去掉的物体/水印，模型自动补全背景' },
  { value: 'dewatermark', label: '去水印', needMask: false, needPrompt: false, hint: '整图去除文字水印，保持背景自然' },
  { value: 'upscale', label: '超分放大', needMask: false, needPrompt: false, hint: '提升分辨率并增强细节（1 倍=仅高清）' },
  { value: 'expand', label: '扩图', needMask: false, needPrompt: false, hint: '向四周自然延展画面，适合改比例' },
  { value: 'colorize', label: '上色', needMask: false, needPrompt: false, hint: '给黑白/线稿画面自然上色' },
  { value: 'doodle', label: '线稿生图', needMask: false, needPrompt: false, hint: '根据线稿生成完整画面' }
]

const MAX_W = 560
const MAX_H = 440

/** 图像编辑：涂抹蒙版（局部重绘/擦除）+ 整图操作（去水印/超分/扩图/上色/线稿） */
export default function ImageEditModal({ open, src, name, onClose, onDone }: Props): JSX.Element {
  const { message } = AntdApp.useApp()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const strokesRef = useRef<Array<Array<{ x: number; y: number }>>>([])
  const drawingRef = useRef(false)
  const [op, setOp] = useState<ImageEditOp>('repaint')
  const [prompt, setPrompt] = useState('')
  const [brush, setBrush] = useState(40)
  const [factor, setFactor] = useState(2)
  const [expandScale, setExpandScale] = useState(1.4)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ready, setReady] = useState(false)
  const [strokeCount, setStrokeCount] = useState(0)
  const def = OPS.find((o) => o.value === op) ?? OPS[0]

  /** 把图片与已画笔画重绘到显示画布（显示坐标 = 图像坐标 × scale） */
  const redraw = useCallback((): void => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const scale = canvas.width / img.naturalWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = 'rgba(255,64,64,0.5)'
    ctx.lineWidth = Math.max(2, brush * scale)
    for (const stroke of strokesRef.current) {
      if (stroke.length === 1) {
        const p = stroke[0]
        ctx.beginPath()
        ctx.arc(p.x * scale, p.y * scale, Math.max(1, (brush * scale) / 2), 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(255,64,64,0.5)'
        ctx.fill()
        continue
      }
      ctx.beginPath()
      stroke.forEach((p, i) => {
        const x = p.x * scale
        const y = p.y * scale
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
    }
  }, [brush])

  // 载入源图（走主进程读取，兼容沙箱）
  useEffect(() => {
    if (!open || !src) return
    let url = ''
    let cancelled = false
    void (async () => {
      try {
        const buf = await window.api.imageRead(src)
        const blob = new Blob([buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer])
        url = URL.createObjectURL(blob)
        const img = new Image()
        img.onload = () => {
          if (cancelled) return
          imgRef.current = img
          const scale = Math.min(MAX_W / img.naturalWidth, MAX_H / img.naturalHeight, 1)
          const canvas = canvasRef.current
          if (canvas) {
            canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
          }
          strokesRef.current = []
          setStrokeCount(0)
          setReady(true)
          redraw()
        }
        img.src = url
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
      imgRef.current = null
      setReady(false)
    }
  }, [open, src, redraw])

  useEffect(() => {
    if (ready) redraw()
  }, [brush, ready, redraw])

  function pos(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = e.currentTarget
    const rect = canvas.getBoundingClientRect()
    const img = imgRef.current
    const scale = img ? img.naturalWidth / canvas.width : 1
    return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale }
  }

  function onDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!ready || busy) return
    drawingRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    strokesRef.current.push([pos(e)])
    redraw()
  }

  function onMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!drawingRef.current) return
    const stroke = strokesRef.current[strokesRef.current.length - 1]
    stroke.push(pos(e))
    redraw()
  }

  function onUp(): void {
    if (!drawingRef.current) return
    drawingRef.current = false
    setStrokeCount(strokesRef.current.length)
  }

  /** 导出蒙版：与原图等尺寸的黑底白笔 PNG（非 0 区域 = 编辑区域） */
  async function exportMask(): Promise<ArrayBuffer | null> {
    const img = imgRef.current
    if (!img || strokesRef.current.length === 0) return null
    const off = document.createElement('canvas')
    off.width = img.naturalWidth
    off.height = img.naturalHeight
    const ctx = off.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, off.width, off.height)
    ctx.strokeStyle = '#fff'
    ctx.fillStyle = '#fff'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = Math.max(2, brush)
    for (const stroke of strokesRef.current) {
      if (stroke.length === 1) {
        const p = stroke[0]
        ctx.beginPath()
        ctx.arc(p.x, p.y, Math.max(1, brush / 2), 0, Math.PI * 2)
        ctx.fill()
        continue
      }
      ctx.beginPath()
      stroke.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
      ctx.stroke()
    }
    const blob = await new Promise<Blob | null>((r) => off.toBlob((b) => r(b), 'image/png'))
    return blob ? await blob.arrayBuffer() : null
  }

  async function apply(): Promise<void> {
    if (!ready) return
    if (def.needMask && strokesRef.current.length === 0) {
      message.warning(`「${def.label}」需要先涂抹区域`)
      return
    }
    setBusy(true)
    setErr('')
    try {
      const mask = def.needMask ? await exportMask() : null
      const scales = op === 'expand' ? { top: expandScale, bottom: expandScale, left: expandScale, right: expandScale } : undefined
      const r = await window.api.imageEdit({
        op,
        name,
        mask: mask ?? undefined,
        prompt: prompt.trim() || undefined,
        factor: op === 'upscale' ? factor : undefined,
        scales,
        runId: crypto.randomUUID()
      })
      onDone(r as GenResult, op)
      message.success(`${def.label}完成`)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="图像编辑"
      open={open}
      onCancel={busy ? undefined : onClose}
      width={680}
      footer={null}
      destroyOnHidden
    >
      <Segmented
        block
        value={op}
        onChange={(v) => setOp(v as ImageEditOp)}
        options={OPS.map((o) => ({ value: o.value, label: o.label }))}
        style={{ marginBottom: 10 }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
        {def.hint}
      </Typography.Text>

      <div className="edit-canvas-wrap">
        <canvas
          ref={canvasRef}
          className={`edit-canvas${def.needMask ? ' brushing' : ''}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={onUp}
        />
      </div>

      {def.needMask && (
        <Space size={12} style={{ width: '100%', marginTop: 8 }} wrap>
          <Space size={6}>
            <Typography.Text style={{ fontSize: 12 }}>笔刷</Typography.Text>
            <Slider value={brush} onChange={setBrush} min={8} max={160} style={{ width: 140 }} />
          </Space>
          <Button size="small" icon={<ClearOutlined />} disabled={!strokeCount} onClick={() => { strokesRef.current = []; setStrokeCount(0); redraw() }}>
            清空涂抹
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已画 {strokeCount} 笔（红色区域 = 将被处理）
          </Typography.Text>
        </Space>
      )}

      {op === 'upscale' && (
        <Space size={8} style={{ marginTop: 8 }}>
          <Typography.Text style={{ fontSize: 12 }}>放大倍数</Typography.Text>
          <Select
            size="small"
            value={factor}
            onChange={setFactor}
            style={{ width: 120 }}
            options={[
              { value: 1, label: '1× 仅高清' },
              { value: 2, label: '2×' },
              { value: 3, label: '3×' },
              { value: 4, label: '4×' }
            ]}
          />
        </Space>
      )}

      {op === 'expand' && (
        <Space size={8} style={{ marginTop: 8 }}>
          <Typography.Text style={{ fontSize: 12 }}>四周扩展</Typography.Text>
          <Select
            size="small"
            value={expandScale}
            onChange={setExpandScale}
            style={{ width: 140 }}
            options={[
              { value: 1.2, label: '1.2× 小幅' },
              { value: 1.4, label: '1.4× 中等' },
              { value: 1.6, label: '1.6× 大幅' },
              { value: 2, label: '2× 最大' }
            ]}
          />
        </Space>
      )}

      {(def.needPrompt || op === 'doodle' || op === 'colorize') && (
        <div style={{ marginTop: 10 }}>
          <Typography.Text style={{ fontSize: 12 }}>提示词</Typography.Text>
          <textarea
            className="edit-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            placeholder={op === 'repaint' ? '例：把这里换成一片海，浪花自然衔接' : '可留空，模型按默认策略处理'}
          />
        </div>
      )}

      {err && <Alert type="error" showIcon message={err} style={{ marginTop: 10 }} />}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
        <Tooltip title="这会消耗一次百炼图像编辑调用">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            结果会存入作品目录，并接在当前图的版本链上
          </Typography.Text>
        </Tooltip>
        <Space>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="primary" icon={<ThunderboltOutlined />} loading={busy} disabled={!ready} onClick={() => void apply()}>
            {busy ? '处理中…' : `应用${def.label}`}
          </Button>
        </Space>
      </div>
    </Modal>
  )
}
