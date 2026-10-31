/**
 * 本机作品抽屉（画布内）——把「历史记录」页的产出直接拉进画布。
 *
 * 为什么放在画布：画布是装配材料的地方，用户想复用上次生成的图时，
 * 不该被迫离开画布去历史页再绕回来。点一张卡就在视口中心落一个图片节点。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Button, Drawer, Empty, Input, Spin, Tooltip } from 'antd'
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons'

import type { HistoryItem } from '../types'

interface MaterialDrawerProps {
  open: boolean
  onClose: () => void
  onInsert: (item: HistoryItem) => void
}

const PAGE_LIMIT = 60

export default function MaterialDrawer({ open, onClose, onInsert }: MaterialDrawerProps): JSX.Element {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const list = (await window.api.history()) as HistoryItem[]
      // 新到旧，最多展示 60 张：抽屉是「快速捞一张」，不是完整历史管理
      setItems(
        (Array.isArray(list) ? list : [])
          .filter((x) => x && typeof x.url === 'string')
          .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
          .slice(0, PAGE_LIMIT)
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    if (!k) return items
    return items.filter((x) => {
      const prompt = x.params?.prompt ?? ''
      return prompt.toLowerCase().includes(k) || x.name.toLowerCase().includes(k)
    })
  }, [items, keyword])

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={420}
      title="本机作品"
      data-material-drawer="true"
      extra={
        <Tooltip title="重新扫描输出目录">
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => void refresh()} data-material-refresh="true" />
        </Tooltip>
      }
    >
      <Input
        allowClear
        size="small"
        prefix={<SearchOutlined />}
        placeholder="按提示词或文件名搜索"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        style={{ marginBottom: 12 }}
        data-material-search="true"
      />
      {error ? <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div> : null}
      {loading && !items.length ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={keyword ? '没有匹配的作品' : '还没有作品，先去创作页生成一张'}
        />
      ) : (
        <div className="ivc-material-grid">
          {filtered.map((item) => (
            <button
              key={item.name}
              className="ivc-material-card"
              title={item.params?.prompt || item.name}
              data-material-item={item.name}
              onClick={() => {
                onInsert(item)
                onClose()
              }}
            >
              <img src={item.url + (item.url.includes('?') ? '&' : '?') + 'w=256'} alt="" loading="lazy" draggable={false} />
              <span className="ivc-material-prompt">{item.params?.prompt || item.name}</span>
            </button>
          ))}
        </div>
      )}
    </Drawer>
  )
}
