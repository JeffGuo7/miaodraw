import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Card,
  Empty,
  Image,
  Space,
  Tooltip,
  Typography
} from 'antd'
import dayjs from 'dayjs'
import {
  ControlOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  RetweetOutlined,
  ScanOutlined
} from '@ant-design/icons'
import type { GenParams, HistoryItem } from '../types'
import { formatSize, mediaUrlData, mediaUrlToFile } from '../utils'

interface Props {
  visible: boolean
  version: number
  onUseRef: (file: File) => void
  onDistill: (data: ArrayBuffer, name: string) => void
  onReproduce: (p: GenParams) => void
}

export default function HistoryView({ visible, version, onUseRef, onDistill, onReproduce }: Props): JSX.Element {
  const { message } = AntdApp.useApp()
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(false)

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

  return (
    <div>
      <div className="lib-toolbar">
        <Typography.Text type="secondary">最近生成的 {items.length} 张作品（outputs 目录）</Typography.Text>
        <div className="toolbar-spacer" />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={refresh}>
          刷新
        </Button>
      </div>
      {items.length === 0 && !loading ? (
        <Empty description="还没有作品，去「创作」画第一张吧" style={{ marginTop: 100 }} />
      ) : (
        <div className="hist-grid">
          {items.map((it) => (
            <Card
              key={it.name}
              size="small"
              className="hist-card"
              styles={{ body: { padding: 8 } }}
              cover={
                <div className="hist-cover">
                  <Image src={it.url} alt={it.name} />
                </div>
              }
            >
              <div className="hist-meta">
                <Typography.Text type="secondary" ellipsis style={{ maxWidth: '100%' }}>
                  {it.name}
                </Typography.Text>
                <Typography.Text type="secondary" className="hist-time">
                  {dayjs(it.mtime).format('MM-DD HH:mm')} · {formatSize(it.size)}
                </Typography.Text>
                {it.params && (
                  <Typography.Text type="secondary" className="hist-time" ellipsis>
                    {it.params.model} · {it.params.w}×{it.params.h} · 种子 {it.params.seed}
                  </Typography.Text>
                )}
              </div>
              <Space size={2} className="hist-actions">
                {it.params && (
                  <Tooltip title="复现参数（填入创作台）">
                    <Button
                      type="text"
                      size="small"
                      icon={<ControlOutlined />}
                      onClick={() => onReproduce(it.params as GenParams)}
                    />
                  </Tooltip>
                )}
                <Tooltip title="保存">
                  <Button
                    type="text"
                    size="small"
                    icon={<DownloadOutlined />}
                    onClick={async () => {
                      const r = await window.api.saveImage(it.url)
                      if (r.ok) message.success(`已保存：${r.path}`)
                      else if (r.err !== '已取消') message.error(r.err)
                    }}
                  />
                </Tooltip>
                <Tooltip title="打开所在文件夹">
                  <Button
                    type="text"
                    size="small"
                    icon={<FolderOpenOutlined />}
                    onClick={() => void window.api.revealImage(it.url)}
                  />
                </Tooltip>
                <Tooltip title="用作底图">
                  <Button type="text" size="small" icon={<RetweetOutlined />} onClick={() => useAsRef(it)} />
                </Tooltip>
                <Tooltip title="反推提示词">
                  <Button type="text" size="small" icon={<ScanOutlined />} onClick={() => distillItem(it)} />
                </Tooltip>
              </Space>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
