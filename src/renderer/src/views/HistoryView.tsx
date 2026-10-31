import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Card,
  Empty,
  Image,
  Dropdown,
  Input,
  Select,
  Space,
  Tooltip,
  Typography
} from 'antd'
import dayjs from 'dayjs'
import {
  ControlOutlined,
  CopyOutlined,
  DeleteOutlined,
  MoreOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  RetweetOutlined,
  ScanOutlined
} from '@ant-design/icons'
import type { GenParams, HistoryItem } from '../types'
import { modelLabel } from '../models'
import { formatSize, mediaUrlData, mediaUrlToFile } from '../utils'

interface Props {
  visible: boolean
  version: number
  onUseRef: (file: File) => void
  onDistill: (data: ArrayBuffer, name: string) => void
  onReproduce: (p: GenParams) => void
}

export default function HistoryView({ visible, version, onUseRef, onDistill, onReproduce }: Props): JSX.Element {
  const { message, modal } = AntdApp.useApp()
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [modelFilter, setModelFilter] = useState<string>('all')
  /** 分批渲染：作品多时一次性铺 1000 张图会明显卡（首次 60，其余按需） */
  const [visibleCount, setVisibleCount] = useState(60)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setItems(await window.api.history())
    } catch (e) {
      message.error(`历史加载失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    if (visible) void refresh()
  }, [visible, version, refresh])

  const modelOptions = useMemo(() => {
    const set = new Set(items.map((it) => it.params?.model).filter((m): m is string => !!m))
    return [{ value: 'all', label: '全部模型' }, ...[...set].map((m) => ({ value: m, label: modelLabel(m) }))]
  }, [items])

  /** 作品库的核心是"找回"：先能搜（提示词/文件名），再能按模型筛 */
  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return items.filter((it) => {
      if (modelFilter !== 'all' && it.params?.model !== modelFilter) return false
      if (!kw) return true
      const hay = (it.params?.prompt ?? '') + ' ' + it.name
      return hay.toLowerCase().includes(kw)
    })
  }, [items, q, modelFilter])

  async function useAsRef(item: HistoryItem): Promise<void> {
    try {
      onUseRef(await mediaUrlToFile(item.url, item.name))
      message.success('已带入创作台作为参考图')
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    }
  }

  async function distillItem(item: HistoryItem): Promise<void> {
    try {
      onDistill(await mediaUrlData(item.url), item.name)
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    }
  }

  async function removeItem(item: HistoryItem): Promise<void> {
    try {
      await window.api.historyDelete(item.name)
      setItems((old) => old.filter((x) => x.name !== item.name))
      message.success('已删除该作品')
    } catch (e) {
      message.error(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div>
      <div className="lib-toolbar">
        <Typography.Text type="secondary">
          本机作品 {filtered.length}
          {filtered.length !== items.length ? ` / ${items.length}` : ''} 张
        </Typography.Text>
        <Input.Search
          allowClear
          placeholder="搜提示词或文件名"
          style={{ width: 240 }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-hist-search="true"
        />
        <Select
          size="middle"
          style={{ width: 160 }}
          value={modelFilter}
          options={modelOptions}
          onChange={setModelFilter}
          data-hist-model-filter="true"
        />
        <div className="toolbar-spacer" />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={refresh}>
          刷新
        </Button>
      </div>
      {items.length === 0 && !loading ? (
        <Empty description="还没有作品，去「创作」画第一张吧" style={{ marginTop: 100 }} />
      ) : (
        <div className="hist-grid">
          {filtered.length === 0 && (
            <Empty description="没有匹配的作品，换个关键词或清空筛选" style={{ marginTop: 60 }} />
          )}
          {filtered.slice(0, visibleCount).map((it) => (
            <Card
              key={it.name}
              size="small"
              className="hist-card"
              styles={{ body: { padding: 8 } }}
              cover={
                <div className="hist-cover">
                  <Image src={`${it.url}?w=340`} preview={{ src: it.url }} loading="lazy" alt={it.name} />
                </div>
              }
            >
              <div className="hist-meta">
                {/* 标题放提示词而不是 image_1792041198393.png：文件名对用户零信息量 */}
                <Tooltip title={it.params?.prompt || it.name}>
                  <div className="hist-title" data-hist-title="true">
                    {it.params?.prompt?.trim() || it.name}
                  </div>
                </Tooltip>
                <div className="hist-sub">
                  {dayjs(it.mtime).format('MM-DD HH:mm')} · {formatSize(it.size)}
                  {it.params ? ` · ${it.params.w}×${it.params.h}` : ''}
                </div>
                {it.params ? (
                  <div className="hist-sub hist-sub-dim">
                    {modelLabel(it.params.model)}
                    {it.params.seed ? ` · 种子 ${it.params.seed}` : ''}
                  </div>
                ) : null}
              </div>
              <Space size={4} className="hist-actions">
                {it.params && (
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    className="repro-btn"
                    icon={<ControlOutlined />}
                    onClick={() => onReproduce(it.params as GenParams)}
                  >
                    复现
                  </Button>
                )}
                <Tooltip title="保存到本地">
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    onClick={async () => {
                      const r = await window.api.saveImage(it.url)
                      if (r.ok) message.success(`已保存：${r.path}`)
                      else if (r.err !== '已取消') message.error(r.err)
                    }}
                  >
                    保存
                  </Button>
                </Tooltip>
                <Dropdown
                  menu={{
                    items: [
                      { key: 'copy', icon: <CopyOutlined />, label: '复制提示词', disabled: !it.params?.prompt },
                      { key: 'folder', icon: <FolderOpenOutlined />, label: '打开所在文件夹' },
                      { key: 'ref', icon: <RetweetOutlined />, label: '用作底图' },
                      { key: 'distill', icon: <ScanOutlined />, label: '反推提示词' },
                      { type: 'divider' as const },
                      { key: 'del', icon: <DeleteOutlined />, label: '删除作品', danger: true }
                    ],
                    onClick: ({ key }) => {
                      if (key === 'copy') {
                        void navigator.clipboard.writeText(it.params?.prompt ?? '')
                        message.success('提示词已复制')
                      } else if (key === 'folder') void window.api.revealImage(it.url)
                      else if (key === 'ref') void useAsRef(it)
                      else if (key === 'distill') void distillItem(it)
                      else if (key === 'del') {
                        modal.confirm({
                          title: '删除这张作品？',
                          content: '会同时删除图片与参数文件，无法恢复。',
                          okText: '删除',
                          okButtonProps: { danger: true },
                          cancelText: '取消',
                          onOk: () => void removeItem(it)
                        })
                      }
                    }
                  }}
                  trigger={['click']}
                >
                  <Button size="small" icon={<MoreOutlined />} data-hist-more="true">
                    更多
                  </Button>
                </Dropdown>
              </Space>
            </Card>
          ))}
        </div>
      )}
      {filtered.length > visibleCount && (
        <div style={{ textAlign: 'center', padding: '18px 0 6px' }}>
          <Button onClick={() => setVisibleCount((v) => v + 60)} data-hist-more-items="true">
            加载更多（还有 {filtered.length - visibleCount} 张）
          </Button>
        </div>
      )}
    </div>
  )
}
