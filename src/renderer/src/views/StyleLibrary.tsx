import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { App as AntdApp, Button, Drawer, Empty, Input, Space, Tag, Tooltip, Typography } from 'antd'
import { SearchOutlined, ThunderboltOutlined } from '@ant-design/icons'
import type { StyleEntry, StyleLibraryData } from '../types'

interface Props {
  open: boolean
  onClose: () => void
  /** 选用某条风格：把提示词填进创作页 */
  onPick: (style: StyleEntry) => void
}

const PAGE = 60

/** 内置风格/提示词库：336 条（手绘风格 245 / 商业模板 22 / 实战提示词 69） */
export default function StyleLibrary({ open, onClose, onPick }: Props): JSX.Element {
  const { message } = AntdApp.useApp()
  const [data, setData] = useState<StyleLibraryData | null>(null)
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('全部')
  const [limit, setLimit] = useState(PAGE)

  useEffect(() => {
    if (!open || data) return
    setLoading(true)
    void window.api
      .styles()
      .then((d) => setData(d))
      .catch(() => message.error('风格库加载失败'))
      .finally(() => setLoading(false))
  }, [open, data, message])

  const categories = useMemo(() => {
    if (!data) return ['全部']
    const set = new Set(data.styles.map((s) => s.category))
    return ['全部', ...[...set].sort()]
  }, [data])

  const list = useMemo(() => {
    if (!data) return []
    const key = q.trim().toLowerCase()
    return data.styles.filter((s) => {
      if (cat !== '全部' && s.category !== cat) return false
      if (!key) return true
      return `${s.title} ${s.category} ${s.tags.join(' ')} ${s.prompt}`.toLowerCase().includes(key)
    })
  }, [data, q, cat])

  function pick(s: StyleEntry): void {
    onPick(s)
    message.success(`已套用「${s.title}」`)
    onClose()
  }

  return (
    <Drawer
      title={
        <Space size={8}>
          <span>风格库</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {data ? `${data.count} 条内置风格与提示词` : '加载中…'}
          </Typography.Text>
        </Space>
      }
      placement="right"
      width={520}
      open={open}
      onClose={onClose}
      styles={{ body: { paddingTop: 12 } }}
    >
      <Input
        allowClear
        prefix={<SearchOutlined />}
        placeholder="搜索风格名、分类或提示词内容…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setLimit(PAGE)
        }}
      />
      <div style={{ margin: '10px 0 6px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {categories.map((c) => (
          <Tag.CheckableTag
            key={c}
            checked={cat === c}
            onChange={() => {
              setCat(c)
              setLimit(PAGE)
            }}
          >
            {c}
          </Tag.CheckableTag>
        ))}
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        共 {list.length} 条{list.length > limit ? `（已显示 ${limit} 条）` : ''}
      </Typography.Text>

      <div className="style-list">
        {loading && <Empty description="正在加载风格库…" />}
        {!loading && list.length === 0 && <Empty description="没有匹配的风格，换个关键词试试" />}
        {list.slice(0, limit).map((s) => (
          <div key={s.id} className="style-card">
            <div className="style-card-head">
              <Typography.Text strong style={{ fontSize: 13 }}>
                {s.title}
              </Typography.Text>
              <Tag color="blue" style={{ marginInlineStart: 6 }}>
                {s.category}
              </Tag>
              {s.tags
                .filter((t) => t !== s.category)
                .slice(0, 2)
                .map((t) => (
                  <Tag key={t}>{t}</Tag>
                ))}
            </div>
            <Typography.Paragraph
              type="secondary"
              className="style-prompt"
              ellipsis={{ rows: 3, expandable: true, symbol: '展开' }}
            >
              {s.prompt}
            </Typography.Paragraph>
            <div className="style-card-foot">
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {s.source}
                {s.credit ? ` · ${s.credit}` : ''}
              </Typography.Text>
              <Space size={6}>
                <Tooltip title="复制提示词">
                  <Button
                    size="small"
                    onClick={() => {
                      void navigator.clipboard.writeText(s.prompt)
                      message.success('提示词已复制')
                    }}
                  >
                    复制
                  </Button>
                </Tooltip>
                <Button size="small" type="primary" icon={<ThunderboltOutlined />} onClick={() => pick(s)}>
                  用这个
                </Button>
              </Space>
            </div>
          </div>
        ))}
      </div>

      {list.length > limit && (
        <div style={{ textAlign: 'center', marginTop: 10 }}>
          <Button onClick={() => setLimit((v) => v + PAGE)}>加载更多</Button>
        </div>
      )}
    </Drawer>
  )
}
