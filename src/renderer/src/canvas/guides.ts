/** 对齐线状态：拖动过程中由 CanvasNode 每帧写入，SnapGuideLayer 订阅渲染 */
import { useSyncExternalStore } from 'react'

import type { SnapGuide } from './snapping'

const EMPTY: SnapGuide[] = []
let guides: SnapGuide[] = EMPTY
const listeners = new Set<() => void>()

export function setGuides(next: SnapGuide[]): void {
  const same = guides.length === next.length && guides.every((g, i) => g.axis === next[i].axis && g.world === next[i].world && g.kind === next[i].kind)
  if (same) return
  guides = next.length ? next : EMPTY
  listeners.forEach((l) => l())
}

export function clearGuides(): void {
  setGuides(EMPTY)
}

export function getGuides(): SnapGuide[] {
  return guides
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function useGuides(): SnapGuide[] {
  return useSyncExternalStore(subscribe, getGuides)
}
