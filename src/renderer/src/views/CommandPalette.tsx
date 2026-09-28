import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Empty, Input, Menu, Modal, Spin, Typography } from 'antd'
import {
  AppstoreOutlined,
  EditOutlined,
  HistoryOutlined,
  PictureOutlined,
  ScanOutlined,
  SearchOutlined,
  SettingOutlined
} from '@ant-design/icons'

export type ViewKey = 'create' | 'compose' | 'library' | 'distill' | 'history' | 'settings'

interface PaletteItem {
  key: string
  icon: JSX.Element
  label: string
  hint?: string
  action: () => void
}

interface Props {
  open: boolean
  onClose: () => void
  onNav: (v: ViewKey) => void
  onUsePrompt: (prompt: string) => void
}

const NAV_ITEMS: Array<{ key: ViewKey; icon: JSX.Element; label: string }> = [
  { key: 'create', icon: <EditOutlined />, label: '打开：创作' },
  { key: 'library', icon: <AppstoreOutlined />, label: '打开：灵感库' },
  { key: 'distill', icon: <ScanOutlined />, label: '打开：提示词反推' },
  { key: 'history', icon: <HistoryOutlined />, label: '打开：历史记录' },
  { key: 'settings', icon: <SettingOutlined />, label: '打开：设置' }
]

export default function CommandPalette({ open, onClose, onNav, onUsePrompt }: Props): JSX.Element {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [lib, setLib] = useState<import('../types').LibraryData | null>(null)
  const [history, setHistory] = useState<import('../types').HistoryItem[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQ('')
    setActive(0)
    if (!lib) void window.api.library().then(setLib).catch(() => undefined)
    void window.api.history().then(setHistory).catch(() => undefined)
  }, [open, lib])

  const items = useMemo<PaletteItem[]>(() => {
    const kw = q.trim().toLowerCase()
    const out: PaletteItem[] = []
    for (const n of NAV_ITEMS) {
      if (!kw || n.label.toLowerCase().includes(kw)) {
        out.push({ key: `nav-${n.key}`, icon: n.icon, label: n.label, action: () => onNav(n.key) })
      }
    }
    if (lib) {
      let count = 0
      for (const cat of Object.values(lib.cats)) {
        for (const c of cat.cases) {
          if (count >= 10) break
          const hit =
            !kw || c.title.toLowerCase().includes(kw) || c.prompt.toLowerCase().includes(kw) || (c.desc ?? '').toLowerCase().includes(kw)
          if (hit) {
            count++
            out.push({
              key: `case-${cat.label}-${c.n}`,
              icon: <PictureOutlined />,
              label: `案例：${c.title}`,
              hint: c.desc?.slice(0, 46),
              action: () => {
                onUsePrompt(c.prompt)
              }
            })
          }
        }
        if (count >= 10) break
      }
    }
    for (const h of history.slice(0, 40)) {
      if (out.length >= 22) break
      if (!kw || h.name.toLowerCase().includes(kw)) {
        out.push({
          key: `hist-${h.name}`,
          icon: <HistoryOutlined />,
          label: `作品：${h.name}`,
          hint: h.params ? `${h.params.model} · 种子 ${h.params.seed}` : undefined,
          action: () => onNav('history')
        })
      }
    }
    return out.slice(0, 22)
  }, [q, lib, history, onNav, onUsePrompt])

  useEffect(() => setActive(0), [q])

  function run(item: PaletteItem | undefined): void {
    if (!item) return
    item.action()
    onClose()
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(items[active])
    }
  }

  useEffect(() => {
    listRef.current
      ?.querySelector('.ant-menu-item-selected')
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={560} closable={false} styles={{ content: { padding: 0 } }}>
      <div className="pal" onKeyDown={onKeyDown}>
        <Input
          size="large"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索页面、案例、作品…（↑↓ 选择，回车打开）"
          prefix={<SearchOutlined style={{ color: '#86868b' }} />}
          variant="borderless"
        />
        <div className="pal-list" ref={listRef}>
          {items.length === 0 ? (
            <Empty description="没有匹配结果" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ margin: '24px 0' }} />
          ) : (
            <Menu
              mode="inline"
              className="pal-menu"
              selectedKeys={[items[active]?.key]}
              items={items.map((it, i) => ({
                key: it.key,
                icon: it.icon,
                label: (
                  <span className="pal-label" onMouseEnter={() => setActive(i)}>
                    <Typography.Text ellipsis style={{ maxWidth: 420 }}>
                      {it.label}
                    </Typography.Text>
                    {it.hint && (
                      <Typography.Text type="secondary" className="pal-hint" ellipsis>
                        {it.hint}
                      </Typography.Text>
                    )}
                  </span>
                )
              }))}
              onClick={({ key }) => run(items.find((x) => x.key === key))}
            />
          )}
        </div>
        {!lib && (
          <div className="pal-loading">
            <Spin size="small" /> <Typography.Text type="secondary">索引案例库中…</Typography.Text>
          </div>
        )}
      </div>
    </Modal>
  )
}
