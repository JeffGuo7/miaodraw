import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Drawer,
  Empty,
  Image,
  Input,
  Pagination,
  Result,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  CopyOutlined,
  HeartFilled,
  HeartOutlined,
  ReloadOutlined,
  RetweetOutlined,
  ScanOutlined
} from '@ant-design/icons'
import type { FavItem, LibCase, LibraryData } from '../types'
import { mediaUrlData, mediaUrlToFile } from '../utils'

const PAGE_SIZE = 60

interface Props {
  visible: boolean
  onUsePrompt: (prompt: string) => void
  onUseRef: (file: File) => void
  onDistill: (data: ArrayBuffer, name: string) => void
}

interface Detail {
  title: string
  prompt: string
  url: string
  file: string
  favKey: string | null
  favBase?: Omit<FavItem, 'savedAt'>
}

function caseUrl(key: string, img: string): string {
  const segs = img.split('/').map(encodeURIComponent).join('/')
  return key.startsWith('b:')
    ? `media://local/lib-b/${encodeURIComponent(img)}`
    : `media://local/lib-a/${segs}`
}

export default function LibraryView({ visible, onUsePrompt, onUseRef, onDistill }: Props): JSX.Element {
  const { message } = AntdApp.useApp()
  const [lib, setLib] = useState<LibraryData | null>(null)
  const [view, setView] = useState<'all' | 'fav'>('all')
  const [cat, setCat] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [favs, setFavs] = useState<FavItem[]>([])
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [reloading, setReloading] = useState(false)

  const loadLibrary = useCallback((reload = false): void => {
    setLoadErr('')
    if (reload) {
      setReloading(true)
      setLib(null)
    }
    window.api
      .library({ reload })
      .then((data) => {
        setLib(data)
        setPage(0)
      })
      .catch((e) => {
        // 错误必须留在页面里：只弹一次 toast 会让这里永久停在 spinner，用户没有出口
        setLoadErr(e instanceof Error ? e.message : String(e))
      })
      .finally(() => setReloading(false))
  }, [])

  useEffect(() => {
    if (!visible) return
    if (!lib && !loadErr) loadLibrary()
    window.api
      .favorites()
      .then(setFavs)
      .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, lib, loadErr])

  const favKeys = useMemo(() => new Set(favs.map((f) => f.key)), [favs])
  const cats = useMemo(() => Object.entries(lib?.cats ?? {}), [lib])

  const allCases = useMemo<LibCase[]>(() => {
    let list = cat ? (lib?.cats[cat]?.cases ?? []) : cats.flatMap(([, c]) => c.cases)
    if (q.trim()) {
      const kw = q.trim().toLowerCase()
      list = list.filter(
        (c) =>
          c.title.toLowerCase().includes(kw) ||
          c.prompt.toLowerCase().includes(kw) ||
          (c.desc ?? '').toLowerCase().includes(kw)
      )
    }
    return list
  }, [lib, cat, q, cats])

  const favFiltered = useMemo(() => {
    if (!q.trim()) return favs
    const kw = q.trim().toLowerCase()
    return favs.filter((f) => f.title.toLowerCase().includes(kw) || f.prompt.toLowerCase().includes(kw))
  }, [favs, q])

  const listLen = view === 'fav' ? favFiltered.length : allCases.length
  const pageItems = useMemo(() => {
    const arr = view === 'fav' ? favFiltered : allCases
    return arr.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  }, [view, favFiltered, allCases, page])

  async function toggleFav(item: Omit<FavItem, 'savedAt'>): Promise<void> {
    try {
      setFavs(await window.api.toggleFavorite(item))
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    }
  }

  const heartBtn = useCallback(
    (favKey: string | null, favBase?: Omit<FavItem, 'savedAt'>): JSX.Element =>
      favKey ? (
        <Tooltip title={favKeys.has(favKey) ? '取消收藏' : '收藏'}>
          <Button
            type="text"
            shape="circle"
            size="small"
            className={`lib-card-fav${favKeys.has(favKey) ? ' on' : ''}`}
            icon={favKeys.has(favKey) ? <HeartFilled /> : <HeartOutlined />}
            onClick={(e) => {
              e.stopPropagation()
              if (favBase) void toggleFav(favBase)
            }}
          />
        </Tooltip>
      ) : (
        <></>
      ),
    [favKeys, message]
  )

  const renderCard = useCallback(
    (opts: {
      c: LibCase
      url: string
      file: string
      chip?: string
      favKey: string | null
      favBase?: Omit<FavItem, 'savedAt'>
    }): JSX.Element => {
      // 只在「精选」或调用方显式指定时显示角标：每张卡都挂同一个分类角标（如「广告创意」）
      // 等于没有信息量，还会和底部标签重复
      const chip = opts.c.featured ? '精选' : opts.chip
      // tags[0] 就是分类（如「广告创意」），和顶部筛选重复：底部只留风格标签
      const footTags = (opts.c.tags ?? []).filter((t) => t !== chip).slice(1, 4)
      return (
        <div
          key={opts.c.key}
          className="lib-card"
          onClick={() =>
            setDetail({
              title: opts.c.title,
              prompt: opts.c.prompt,
              url: opts.url,
              file: opts.file,
              favKey: opts.favKey,
              favBase: opts.favBase
            })
          }
        >
          {opts.c.img ? (
            <div className="lib-card-imgwrap">
              <img loading="lazy" src={`${opts.url}?w=336`} alt={opts.c.title} />
              {chip && <span className={`lib-card-chip${opts.c.featured ? ' featured' : ''}`}>{chip}</span>}
              {heartBtn(opts.favKey, opts.favBase)}
            </div>
          ) : (
            <div className="lib-card-empty">暂无示例图</div>
          )}
          <div className="lib-card-body">
            <div className="lib-card-title">{opts.c.title}</div>
            {opts.c.desc && <div className="lib-card-desc">{opts.c.desc}</div>}
            <div className="lib-card-foot">
              {footTags.map((t) => (
                <span key={t} className="lib-mini-tag">
                  {t}
                </span>
              ))}
              {opts.c.source && <span className="lib-card-src">{opts.c.source}</span>}
            </div>
          </div>
        </div>
      )
    },
    [heartBtn]
  )

  async function useAsRef(): Promise<void> {
    if (!detail?.url) return
    try {
      const f = await mediaUrlToFile(detail.url, detail.file)
      onUseRef(f)
      message.success('已带入创作台作为参考图')
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    }
  }

  async function distillCase(): Promise<void> {
    if (!detail?.url) return
    try {
      onDistill(await mediaUrlData(detail.url), detail.file)
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="lib-wrap">
      <div className="lib-toolbar">
        {view === 'fav' && (
          <Segmented value="fav" options={[{ value: 'fav', label: `我的收藏 · ${favs.length}` }]} />
        )}
        <Segmented
          value={view}
          onChange={(v) => {
            setView(v as 'all' | 'fav')
            setPage(0)
          }}
          options={[
            { value: 'all', label: '全部' },
            { value: 'fav', label: '收藏' }
          ]}
        />
        {view === 'all' && (
          <Select
            value={cat ?? undefined}
            onChange={(v) => {
              setCat(v ?? null)
              setPage(0)
            }}
            allowClear
            placeholder="全部分类"
            style={{ width: 170 }}
            options={cats.map(([k, c]) => ({ value: k, label: `${c.label} ${c.cases.length}` }))}
          />
        )}
        <Input.Search
          placeholder="搜标题或提示词关键词"
          allowClear
          style={{ width: 280 }}
          onSearch={(v) => {
            setQ(v)
            setPage(0)
          }}
          onChange={(e) => {
            // 1243 条过滤是纯内存操作，直接实时过滤；只在回车时过滤会白白多点一次
            setQ(e.target.value)
            setPage(0)
          }}
        />
        <div className="toolbar-spacer" />
        <Typography.Text type="secondary">{lib ? `共 ${lib.total} 个案例` : ''}</Typography.Text>
        <Button icon={<ReloadOutlined />} loading={reloading} onClick={() => loadLibrary(true)} data-lib-reload="true">
          重新扫描
        </Button>
      </div>

      {loadErr && !lib ? (
        <Result
          status="warning"
          title="案例库没能加载"
          subTitle={loadErr}
          extra={
            <Button type="primary" icon={<ReloadOutlined />} onClick={() => loadLibrary(true)} data-lib-retry="true">
              重试
            </Button>
          }
        />
      ) : !lib && view === 'all' ? (
        <div className="lib-loading">
          <Spin size="large" />
          <Typography.Text type="secondary" style={{ marginTop: 14 }}>
            正在扫描案例库（首次要计算去重指纹，可能需要几十秒）…
          </Typography.Text>
        </div>
      ) : listLen === 0 ? (
        <Empty
          description={view === 'fav' ? '还没有收藏 —— 在卡片右上角点心形即可收藏' : '没有匹配的案例'}
          style={{ marginTop: 80 }}
        />
      ) : (
        <>
          <div className="lib-grid">
            {pageItems.map((it) =>
              view === 'fav' ? (
                renderCard({
                  c: {
                    ...(it as FavItem),
                    n: (it as FavItem).n,
                    key: (it as FavItem).key
                  },
                  url: (it as FavItem).img ? caseUrl((it as FavItem).key, (it as FavItem).img) : '',
                  file: (it as FavItem).img ? (it as FavItem).img.split('/').pop()! : 'case.png',
                  favKey: (it as FavItem).key,
                  favBase: {
                    key: (it as FavItem).key,
                    src: (it as FavItem).src,
                    n: (it as FavItem).n,
                    title: (it as FavItem).title,
                    prompt: (it as FavItem).prompt,
                    img: (it as FavItem).img
                  }
                })
              ) : (
                renderCard({
                  c: it as LibCase,
                  url: (it as LibCase).img ? caseUrl((it as LibCase).key, (it as LibCase).img) : '',
                  file: (it as LibCase).img ? (it as LibCase).img.split('/').pop()! : 'case.png',
                  favKey: (it as LibCase).key,
                  favBase: {
                    key: (it as LibCase).key,
                    src: (it as LibCase).key.startsWith('b:') ? 'b' : 'a',
                    n: (it as LibCase).n,
                    title: (it as LibCase).title,
                    prompt: (it as LibCase).prompt,
                    img: (it as LibCase).img
                  }
                })
              )
            )}
          </div>
          <div className="lib-pager">
            <Pagination
              current={page + 1}
              pageSize={PAGE_SIZE}
              total={listLen}
              showSizeChanger={false}
              showTotal={(t) => `共 ${t} 个`}
              onChange={(p) => setPage(p - 1)}
            />
          </div>
        </>
      )}

      <Drawer title={detail?.title} width={560} open={!!detail} onClose={() => setDetail(null)} destroyOnClose>
        {detail && (
          <div className="detail-body">
            {detail.url ? (
              <Image src={detail.url} alt={detail.title} style={{ width: '100%' }} />
            ) : (
              <Empty description="暂无示例图" />
            )}
            <Typography.Paragraph className="detail-prompt" copyable={{ text: detail.prompt }}>
              {detail.prompt}
            </Typography.Paragraph>
            <Space wrap style={{ marginTop: 8 }}>
              <Button
                type="primary"
                onClick={() => {
                  onUsePrompt(detail.prompt)
                  setDetail(null)
                }}
              >
                用这个提示词创作
              </Button>
              <Button icon={<RetweetOutlined />} disabled={!detail.url} onClick={useAsRef}>
                以此图作参考
              </Button>
              <Button icon={<ScanOutlined />} disabled={!detail.url} onClick={distillCase}>
                蒸馏这张图
              </Button>
              <Button
                icon={
                  detail.favKey && favKeys.has(detail.favKey) ? (
                    <HeartFilled style={{ color: '#ff2d55' }} />
                  ) : (
                    <HeartOutlined />
                  )
                }
                disabled={!detail.favKey}
                onClick={() => detail.favBase && void toggleFav(detail.favBase)}
              >
                {detail.favKey && favKeys.has(detail.favKey) ? '已收藏' : '收藏'}
              </Button>
              <Button
                icon={<CopyOutlined />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(detail.prompt)
                    message.success('提示词已复制')
                  } catch {
                    message.warning('复制失败，请手动选择文本复制')
                  }
                }}
              >
                复制提示词
              </Button>
            </Space>
            <div style={{ marginTop: 10 }}>
              <Tag>提示词来自开源案例库，出图风格与示例图近似</Tag>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
