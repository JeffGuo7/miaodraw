import type { JSX } from 'react'
import { useRef, useState } from 'react'
import { DoubleLeftOutlined, DoubleRightOutlined } from '@ant-design/icons'

export default function CompareSlider({ before, after }: { before: string; after: string }): JSX.Element {
  const [pos, setPos] = useState(50)
  const ref = useRef<HTMLDivElement>(null)

  function move(clientX: number): void {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    setPos(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)))
  }

  return (
    <div
      ref={ref}
      className="cmp"
      onPointerDown={(e) => {
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        move(e.clientX)
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) move(e.clientX)
      }}
    >
      <img src={after} alt="after" draggable={false} />
      <div className="cmp-before" style={{ width: `${pos}%` }}>
        <img src={before} alt="before" draggable={false} />
      </div>
      <div className="cmp-handle" style={{ left: `${pos}%` }}>
        <span className="cmp-knob">
          <DoubleLeftOutlined style={{ fontSize: 10 }} />
          <DoubleRightOutlined style={{ fontSize: 10, marginLeft: 3 }} />
        </span>
      </div>
      <span className="cmp-tag l">前</span>
      <span className="cmp-tag r">后</span>
    </div>
  )
}
