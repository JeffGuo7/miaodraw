import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntdApp, Badge, Layout, Menu, Tooltip, Typography } from 'antd'
import {
  AppstoreOutlined,
  BlockOutlined,
  EditOutlined,
  HistoryOutlined,
  ScanOutlined,
  SettingOutlined
} from '@ant-design/icons'
import CreateView from './views/CreateView'
import ComposeView from './views/ComposeView'
import LibraryView from './views/LibraryView'
import DistillView from './views/DistillView'
import HistoryView from './views/HistoryView'
import CommandPalette, { type ViewKey } from './views/CommandPalette'
import SettingsView from './views/SettingsView'
import Onboarding from './views/Onboarding'
import StatusBar from './views/StatusBar'
import type { GenParams, HealthInfo } from './types'

interface CreateSeed {
  ts: number
  prompt?: string
  mode?: 't2i' | 'i2i'
  refFile?: File
  negative?: string
  size?: string
  model?: string
  seed?: number
}

interface DistillSeed {
  ts: number
  data: ArrayBuffer
  name: string
}

const NAV: Array<{ key: ViewKey; icon: JSX.Element; label: string }> = [
  { key: 'create', icon: <EditOutlined />, label: '创 作' },
  { key: 'compose', icon: <BlockOutlined />, label: '合成' },
  { key: 'library', icon: <AppstoreOutlined />, label: '灵感库' },
  { key: 'distill', icon: <ScanOutlined />, label: '提示词反推' },
  { key: 'history', icon: <HistoryOutlined />, label: '历史记录' },
  { key: 'settings', icon: <SettingOutlined />, label: '设置' }
]

const TITLES: Record<ViewKey, string> = {
  create: '创作',
  compose: '合成画布',
  library: '灵感库',
  distill: '提示词反推',
  history: '历史记录',
  settings: '设置'
}

function Logo(): JSX.Element {
  return (
    <div className="logo">
      <svg width="30" height="30" viewBox="0 0 48 48" fill="none">
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="48" y2="48">
            <stop stopColor="#5b8cff" />
            <stop offset="1" stopColor="#8b5cf6" />
          </linearGradient>
        </defs>
        <rect width="48" height="48" rx="12" fill="url(#lg)" />
        <path
          d="M24 10c-7.7 0-14 5.6-14 12.6 0 4.1 2.2 7.7 5.6 10 .4.3.6.8.5 1.3l-.6 2.4c-.2.8.6 1.5 1.4 1.1l3.9-2c.3-.2.7-.2 1-.1.7.1 1.4.2 2.2.2 7.7 0 14-5.6 14-12.9S31.7 10 24 10Z"
          fill="#fff"
          fillOpacity=".92"
        />
        <circle cx="17.5" cy="22.5" r="2" fill="#5b8cff" />
        <circle cx="24" cy="22.5" r="2" fill="#5b8cff" />
        <circle cx="30.5" cy="22.5" r="2" fill="#5b8cff" />
      </svg>
      <span className="logo-name">妙绘工作台</span>
    </div>
  )
}

export default function App(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [view, setView] = useState<ViewKey>('create')
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [version, setVersion] = useState('')
  const [createSeed, setCreateSeed] = useState<CreateSeed>({ ts: 0 })
  const [distillSeed, setDistillSeed] = useState<DistillSeed | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [palOpen, setPalOpen] = useState(false)
  const [onboardOpen, setOnboardOpen] = useState(false)
  const healthTimer = useRef<number>(0)

  const refreshHealth = useCallback((): void => {
    window.api
      .health()
      .then(setHealth)
      .catch(() => setHealth({ ok: false, version: '', entry: '', hasKey: false, libraryReady: false, outputsDir: '' }))
  }, [])

  useEffect(() => {
    refreshHealth()
    window.api.appInfo().then((i) => setVersion(i.version)).catch(() => undefined)
    healthTimer.current = window.setInterval(refreshHealth, 60000)
    window.api
      .getSettings()
      .then((s) => {
        if (!s.onboarded) setOnboardOpen(true)
      })
      .catch(() => undefined)
    return () => window.clearInterval(healthTimer.current)
  }, [refreshHealth])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const goCreate = useCallback((patch: Omit<CreateSeed, 'ts'>): void => {
    setCreateSeed({ ...patch, ts: Date.now() })
    setView('create')
  }, [])

  const goDistill = useCallback((data: ArrayBuffer, name: string): void => {
    setDistillSeed({ ts: Date.now(), data, name })
    setView('distill')
  }, [])

  const onUsePrompt = useCallback(
    (prompt: string): void => {
      goCreate({ prompt, mode: 't2i' })
      message.success('提示词已填入创作台')
    },
    [goCreate, message]
  )

  const onReproduce = useCallback(
    (p: GenParams): void => {
      goCreate({
        prompt: p.prompt,
        negative: p.negative,
        mode: 't2i',
        size: `${p.w}x${p.h}`,
        model: p.model,
        seed: p.seed
      })
      message.success('参数已填入创作台，点生成即可复现')
    },
    [goCreate, message]
  )

  return (
    <Layout className="app-layout">
      <Layout.Sider width={200} className="app-sider">
        <Logo />
        <Menu
        mode="inline"
        selectedKeys={[view]}
          items={NAV.map((n) => ({ key: n.key, icon: n.icon, label: n.label }))}
          onClick={(e) => setView(e.key as ViewKey)}
        />
        <div className="sider-foot">
          {version && <Typography.Text type="secondary">v{version}</Typography.Text>}
          <Typography.Text type="secondary">百炼 API 驱动</Typography.Text>
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Header className="app-header">
          <Typography.Title level={4} style={{ margin: 0 }}>
            {TITLES[view]}
          </Typography.Title>
          <div className="header-right">
            <Tooltip title={health ? `百炼 CLI ${health.version || '未检测到'} · 点击刷新` : '点击刷新'}>
              <Badge
                status={health ? (health.ok ? 'success' : 'error') : 'default'}
                text={
                  <span className="status-text" onClick={refreshHealth}>
                    {health ? (health.ok ? `引擎在线 · ${health.version}` : '引擎离线') : '检测引擎…'}
                  </span>
                }
              />
            </Tooltip>
          </div>
        </Layout.Header>
        <Layout.Content className="app-content">
          <div style={{ display: view === 'create' ? 'block' : 'none' }}>
            <CreateView
              seed={createSeed}
              onDistill={goDistill}
              onHealthStale={refreshHealth}
              onGenerated={() => setHistoryVersion((v) => v + 1)}
              onOpenSettings={() => setView('settings')}
            />
          </div>
          <div style={{ display: view === 'compose' ? 'block' : 'none' }}>
            <ComposeView visible={view === 'compose'} />
          </div>
          <div style={{ display: view === 'library' ? 'block' : 'none' }}>
            <LibraryView visible={view === 'library'} onUsePrompt={onUsePrompt} onUseRef={(f) => goCreate({ mode: 'i2i', refFile: f })} onDistill={goDistill} />
          </div>
          <div style={{ display: view === 'distill' ? 'block' : 'none' }}>
            <DistillView seed={distillSeed} onUsePrompt={onUsePrompt} />
          </div>
          <div style={{ display: view === 'history' ? 'block' : 'none' }}>
            <HistoryView
              visible={view === 'history'}
              version={historyVersion}
              onUseRef={(f) => goCreate({ mode: 'i2i', refFile: f })}
              onDistill={goDistill}
              onReproduce={onReproduce}
            />
          </div>
          <div style={{ display: view === 'settings' ? 'block' : 'none' }}>
            <SettingsView visible={view === 'settings'} />
          </div>
        </Layout.Content>
        <StatusBar onOpenPalette={() => setPalOpen(true)} version={version} />
      </Layout>
      <CommandPalette
        open={palOpen}
        onClose={() => setPalOpen(false)}
        onNav={setView}
        onUsePrompt={onUsePrompt}
      />
      <Onboarding open={onboardOpen} onClose={() => setOnboardOpen(false)} />
    </Layout>
  )
}
