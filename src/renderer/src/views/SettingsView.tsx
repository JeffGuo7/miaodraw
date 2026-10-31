import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { App as AntdApp, Input, Modal, Space, Typography } from 'antd'
import type { BailianKeyInfo, HealthInfo, ModelCap, ModelConfig, ProviderKeyInfo } from '../types'
import { PROVIDERS } from '../models'
import SettingsNav from './settings/SettingsNav'
import ServicesSection from './settings/ServicesSection'
import DefaultsSection from './settings/DefaultsSection'
import StatusSection from './settings/StatusSection'
import { AboutSection, DataSection } from './settings/InfoSections'
import { builtinCaps, guessCaps } from './settings/shared'
import type { SectionKey, UiModel, UiProvider } from './settings/shared'
import './settings/settings.css'

interface AppInfoShape {
  version: string
  name: string
  libraryRoot: string
  outputsDir: string
}

/** 内置供应商固定端点（与 main/providers.ts 的 PROVIDER_BASE_URLS 对齐，仅用于展示） */
const BUILTIN_BASE: Record<string, string> = {
  bailian: 'https://dashscope.aliyuncs.com',
  siliconflow: 'https://api.siliconflow.cn/v1',
  openai: 'https://api.openai.com/v1'
}

export default function SettingsView({ visible }: { visible: boolean }): JSX.Element {
  const { message } = AntdApp.useApp()
  const [section, setSection] = useState<SectionKey>('services')
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [info, setInfo] = useState<AppInfoShape | null>(null)
  const [fetching, setFetching] = useState<string | null>(null)
  const [pkInfo, setPkInfo] = useState<Record<string, ProviderKeyInfo>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [mc, setMc] = useState<ModelConfig>({})
  const [cpModal, setCpModal] = useState(false)
  const [cpForm, setCpForm] = useState<{ name: string; baseUrl: string; key: string }>({ name: '', baseUrl: '', key: '' })
  const [bk, setBk] = useState<BailianKeyInfo | null>(null)
  const [bkInput, setBkInput] = useState('')
  const [wsInput, setWsInput] = useState('')
  const [baseUrlInput, setBaseUrlInput] = useState('')
  /** 已落盘的接入点，用于判断「API 地址」是否有未保存修改 */
  const [savedBaseUrl, setSavedBaseUrl] = useState('')
  const [selectedProvider, setSelectedProvider] = useState('bailian')
  const [providerSearch, setProviderSearch] = useState('')
  const [customEdits, setCustomEdits] = useState<Record<string, { name?: string; baseUrl?: string }>>({})

  async function refresh(): Promise<void> {
    await Promise.all([
      // 带 force："重新检测"必须真的重探，不能拿缓存里的旧结论
      window.api.health({ force: true }).then(setHealth).catch(() => undefined),
      window.api.appInfo().then(setInfo).catch(() => undefined),
      window.api.bailianKeyGet().then(setBk).catch(() => undefined),
      window.api.providerKeyGet().then(setPkInfo).catch(() => undefined),
      window.api.modelConfigGet().then(setMc).catch(() => undefined),
      window.api
        .getSettings()
        .then((s) => {
          const adv = s as { bailianWorkspace?: string; bailianBaseUrl?: string }
          setWsInput(adv.bailianWorkspace ?? '')
          setBaseUrlInput(adv.bailianBaseUrl ?? '')
          setSavedBaseUrl(adv.bailianBaseUrl ?? '')
        })
        .catch(() => undefined)
    ])
  }

  useEffect(() => {
    if (visible) void refresh()
  }, [visible])

  // ---------- 供应商视图模型：内置模板 + 自定义供应商统一成一套 UI 描述 ----------
  const providers = useMemo<UiProvider[]>(() => {
    const disabled = new Set(mc.disabledProviders ?? [])
    const builtins: UiProvider[] = PROVIDERS.map((p) => {
      const isBailian = p.id === 'bailian'
      const keyInfo: ProviderKeyInfo | undefined = isBailian
        ? bk
          ? { configured: bk.configured, masked: bk.masked, plainFallback: bk.plainFallback }
          : undefined
        : pkInfo[p.id]
      const extras = mc.extraModels?.[p.id] ?? []
      const fetched = mc.fetchedModels?.[p.id] ?? []
      const models: UiModel[] = [
        ...p.models.map((m) => ({
          id: m.model,
          name: m.label,
          caps: builtinCaps(p.id, m.model),
          source: 'builtin' as const,
          deletable: false
        })),
        ...extras.map((m) => ({
          id: m.id,
          name: m.name || m.id,
          caps: m.caps,
          source: 'extra' as const,
          deletable: true
        })),
        ...fetched
          .filter((id) => !p.models.some((m) => m.model === id) && !extras.some((m) => m.id === id))
          .map((id) => ({ id, name: id, caps: guessCaps(id), source: 'fetched' as const, deletable: true }))
      ]
      return {
        id: p.id,
        kind: 'builtin' as const,
        name: p.label,
        note: p.note,
        baseUrl: isBailian ? baseUrlInput.trim() || BUILTIN_BASE.bailian : BUILTIN_BASE[p.id] || '',
        baseUrlEditable: isBailian,
        baseUrlDirty: isBailian && baseUrlInput.trim() !== savedBaseUrl.trim(),
        enabled: !disabled.has(p.id),
        configured: !!keyInfo?.configured,
        masked: keyInfo?.masked ?? '',
        plainFallback: !!keyInfo?.plainFallback,
        models
      }
    })
    const customs: UiProvider[] = (mc.customProviders ?? []).map((c) => ({
      id: c.id,
      kind: 'custom' as const,
      name: c.name,
      note: '自定义 OpenAI 兼容供应商',
      baseUrl: c.baseUrl,
      baseUrlEditable: true,
      baseUrlDirty: false,
      enabled: c.enabled && !disabled.has(c.id),
      configured: !!pkInfo[c.id]?.configured,
      masked: pkInfo[c.id]?.masked ?? '',
      plainFallback: !!pkInfo[c.id]?.plainFallback,
      models: c.models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        caps: m.caps,
        source: 'custom' as const,
        deletable: true
      }))
    }))
    return [...builtins, ...customs]
  }, [mc, pkInfo, bk, baseUrlInput, savedBaseUrl])

  // 5→3 合并后：百炼（密钥/工作空间/接入点）由 StatusSection 独立管理，
  // 服务商列表只展示第三方，避免同一把密钥在页面里出现两套输入框
  const thirdPartyProviders = useMemo(() => providers.filter((p) => p.id !== 'bailian'), [providers])
  const activeThirdPartyId = thirdPartyProviders.some((p) => p.id === selectedProvider)
    ? selectedProvider
    : thirdPartyProviders[0]?.id ?? ''
  const keyDrafts = useMemo<Record<string, string>>(() => ({ ...drafts, bailian: bkInput }), [drafts, bkInput])

  // ---------- 模型配置写入 ----------
  async function saveConfig(next: ModelConfig): Promise<void> {
    const saved = await window.api.modelConfigSet(next)
    setMc(saved)
  }

  async function setDefault(kind: ModelCap, key: string): Promise<void> {
    await saveConfig({ ...mc, defaults: { ...mc.defaults, [kind]: key } })
    message.success('默认模型已更新')
  }

  async function toggleProvider(id: string, enabled: boolean): Promise<void> {
    const set = new Set(mc.disabledProviders ?? [])
    if (enabled) set.delete(id)
    else set.add(id)
    const customs = (mc.customProviders ?? []).map((c) => (c.id === id ? { ...c, enabled } : c))
    await saveConfig({ ...mc, disabledProviders: Array.from(set), customProviders: customs })
    message.success(enabled ? '已启用该服务商' : '已停用：创作页与默认模型列表中不再出现')
  }

  async function addModel(providerId: string, m: { id: string; name: string; caps: ModelCap[] }): Promise<void> {
    const id = m.id.trim()
    if (!id) {
      message.warning('请填写模型 ID')
      return
    }
    const entry = { id, name: m.name.trim() || id, caps: m.caps.length ? m.caps : (['image'] as ModelCap[]) }
    const custom = (mc.customProviders ?? []).find((c) => c.id === providerId)
    if (custom) {
      if (custom.models.some((x) => x.id === id)) {
        message.warning('该模型 ID 已存在')
        return
      }
      await saveConfig({
        ...mc,
        customProviders: (mc.customProviders ?? []).map((c) =>
          c.id === providerId ? { ...c, models: [...c.models, entry] } : c
        )
      })
    } else {
      const list = mc.extraModels?.[providerId] ?? []
      if (list.some((x) => x.id === id)) {
        message.warning('该模型 ID 已存在')
        return
      }
      await saveConfig({ ...mc, extraModels: { ...mc.extraModels, [providerId]: [...list, entry] } })
    }
    message.success('模型已添加，创作页即可选用')
  }

  async function removeModel(providerId: string, modelId: string): Promise<void> {
    const custom = (mc.customProviders ?? []).find((c) => c.id === providerId)
    if (custom) {
      await saveConfig({
        ...mc,
        customProviders: (mc.customProviders ?? []).map((c) =>
          c.id === providerId ? { ...c, models: c.models.filter((m) => m.id !== modelId) } : c
        )
      })
    } else {
      const extras = (mc.extraModels?.[providerId] ?? []).filter((m) => m.id !== modelId)
      const fetched = (mc.fetchedModels?.[providerId] ?? []).filter((id) => id !== modelId)
      await saveConfig({
        ...mc,
        extraModels: { ...mc.extraModels, [providerId]: extras },
        fetchedModels: { ...mc.fetchedModels, [providerId]: fetched }
      })
    }
    message.success('已移除该模型')
  }

  async function updateCustom(id: string, patch: { name?: string; baseUrl?: string }): Promise<void> {
    const clean: { name?: string; baseUrl?: string } = {}
    if (patch.name !== undefined) clean.name = patch.name
    if (patch.baseUrl !== undefined) clean.baseUrl = patch.baseUrl
    if (Object.keys(clean).length === 0) return
    await saveConfig({
      ...mc,
      customProviders: (mc.customProviders ?? []).map((c) => (c.id === id ? { ...c, ...clean } : c))
    })
  }

  async function saveCustomEdits(id: string): Promise<void> {
    const e = customEdits[id]
    if (!e) return
    const patch: { name?: string; baseUrl?: string } = {}
    if (e.name !== undefined && e.name.trim()) patch.name = e.name.trim()
    if (e.baseUrl !== undefined && e.baseUrl.trim()) patch.baseUrl = e.baseUrl.trim()
    await updateCustom(id, patch)
    setCustomEdits((s) => {
      const next = { ...s }
      delete next[id]
      return next
    })
    message.success('已保存该服务商信息')
  }

  async function addCustomProvider(): Promise<void> {
    const name = cpForm.name.trim()
    const baseUrl = cpForm.baseUrl.trim()
    if (!name || !baseUrl) {
      message.warning('名称与 API 地址必填')
      return
    }
    const id = `custom-${Date.now()}`
    await saveConfig({
      ...mc,
      customProviders: [...(mc.customProviders ?? []), { id, name, baseUrl, enabled: true, models: [] }]
    })
    if (cpForm.key.trim()) await window.api.providerKeySet(id, cpForm.key.trim())
    setCpModal(false)
    setCpForm({ name: '', baseUrl: '', key: '' })
    setSelectedProvider(id)
    setSection('services')
    void window.api.providerKeyGet().then(setPkInfo).catch(() => undefined)
    message.success('自定义服务商已添加，接下来添加它的模型')
  }

  async function removeCustom(id: string): Promise<void> {
    await saveConfig({ ...mc, customProviders: (mc.customProviders ?? []).filter((c) => c.id !== id) })
    await window.api.providerKeyClear(id)
    setSelectedProvider('bailian')
    message.success('已删除该自定义服务商')
  }

  // ---------- 密钥 ----------
  async function saveBailianKey(): Promise<void> {
    const r = await window.api.bailianKeySet(bkInput.trim())
    if (!r.ok) {
      message.error(r.err)
      return
    }
    setBk(r.info)
    setBkInput('')
    if (r.plainFallback) message.warning('已保存，但本机系统安全存储不可用，密钥以编码形式保存（仅本机能读，建议尽快改用登录态）')
    else message.success('百炼密钥已加密保存，立即可用')
    refreshHealthNow()
  }

  /** 任意服务商的密钥/接入点变化后都要重新探测：否则顶栏与创作页仍按旧结论判断 */
  function refreshHealthNow(): void {
    void window.api.health({ force: true }).then(setHealth).catch(() => undefined)
    // 顶栏/状态栏挂在 App 上，这里广播一下让它们立即刷新（否则最多滞后 60s 轮询）
    window.dispatchEvent(new CustomEvent('health-changed'))
  }

  async function saveProviderKey(provider: string): Promise<void> {
    const draft = (drafts[provider] ?? '').trim()
    if (!draft) {
      message.warning('请先粘贴 API Key')
      return
    }
    const r = await window.api.providerKeySet(provider, draft)
    if (!r.ok) {
      message.error(r.err)
      return
    }
    setPkInfo(r.info)
    setDrafts((d) => ({ ...d, [provider]: '' }))
    if (r.plainFallback) message.warning('已保存，但本机系统安全存储不可用，密钥以编码形式保存（仅本机能读）')
    else message.success('密钥已加密保存')
    refreshHealthNow()
  }

  function setKeyDraft(id: string, v: string): void {
    if (id === 'bailian') setBkInput(v)
    else setDrafts((d) => ({ ...d, [id]: v }))
  }

  async function saveKeyFor(id: string): Promise<void> {
    if (id === 'bailian') await saveBailianKey()
    else await saveProviderKey(id)
  }

  async function clearKeyFor(id: string): Promise<void> {
    if (id === 'bailian') {
      setBk(await window.api.bailianKeyClear())
      message.success('已清除应用内百炼密钥')
      refreshHealthNow()
      return
    }
    const r = await window.api.providerKeyClear(id)
    if (r.ok) {
      setPkInfo(r.info)
      message.success('已清除该服务商密钥')
      refreshHealthNow()
    } else {
      message.error(r.err)
    }
  }

  async function testKeyFor(id: string): Promise<void> {
    setTesting(id)
    try {
      const r = id === 'bailian' ? await window.api.bailianKeyTest() : await window.api.testProvider(id)
      if (r.ok) message.success(r.out)
      else message.error(`测试失败：${r.out}`)
    } finally {
      setTesting(null)
    }
  }

  async function saveWorkspace(): Promise<void> {
    await window.api.bailianWsSet({ ws: wsInput.trim(), baseUrl: baseUrlInput.trim() })
    setSavedBaseUrl(baseUrlInput.trim())
    message.success('工作空间 / 接入点已保存并即时生效')
  }

  /** 从服务端 /models 拉取模型目录并入库（Cherry Studio 式自动发现） */
  async function fetchModelList(provider: string): Promise<void> {
    setFetching(provider)
    try {
      const r = await window.api.fetchModels(provider)
      if (r.ok) {
        message.success(`已拉取 ${r.models} 个模型（服务端共 ${r.total} 个，已过滤语音/向量等无关模型）`)
        setMc(await window.api.modelConfigGet())
      } else {
        message.error(`拉取失败：${r.out}`)
      }
    } finally {
      setFetching(null)
    }
  }

  function changeBaseUrl(id: string, v: string): void {
    if (id === 'bailian') setBaseUrlInput(v)
    else setCustomEdits((s) => ({ ...s, [id]: { ...s[id], baseUrl: v } }))
  }

  /** 就地保存「API 地址」：百炼走现有 bailianWsSet，自定义供应商走 modelConfig */
  async function saveBaseUrl(id: string): Promise<void> {
    if (id === 'bailian') await saveWorkspace()
    else await saveCustomEdits(id)
  }

  function editCustom(id: string, patch: { name?: string; baseUrl?: string }): void {
    setCustomEdits((s) => ({ ...s, [id]: { ...s[id], ...patch } }))
  }

  return (
    <div className="settings-wrap">
      <SettingsNav active={section} onChange={setSection} />
      <div className="settings-main">
        {section === 'services' && (
          <>
            {/* 百炼：密钥 + 工作空间 + 接入点 + 健康状态（原「服务状态」分区并入） */}
            <StatusSection
              health={health}
              bk={bk}
              keyDraft={bkInput}
              onKeyDraft={setBkInput}
              onSaveKey={() => void saveBailianKey()}
              onClearKey={() => void clearKeyFor('bailian')}
              onTest={() => void testKeyFor('bailian')}
              testing={testing === 'bailian'}
              fetching={fetching === 'bailian'}
              onFetchModels={() => void fetchModelList('bailian')}
              onRecheck={refresh}
              wsInput={wsInput}
              onWsInput={setWsInput}
              baseUrlInput={baseUrlInput}
              onBaseUrlInput={setBaseUrlInput}
              onSaveWs={() => void saveWorkspace()}
            />
            {/* 第三方供应商（百炼不在此列，避免同一把密钥出现两套输入框） */}
            <ServicesSection
              providers={thirdPartyProviders}
              selectedId={activeThirdPartyId}
              onSelect={setSelectedProvider}
              search={providerSearch}
              onSearch={setProviderSearch}
              onAddProvider={() => setCpModal(true)}
              onToggle={(id, v) => void toggleProvider(id, v)}
              keyDrafts={keyDrafts}
              onKeyDraft={setKeyDraft}
              onSaveKey={(id) => void saveKeyFor(id)}
              onClearKey={(id) => void clearKeyFor(id)}
              onTest={(id) => void testKeyFor(id)}
              testingId={testing}
              fetchingId={fetching}
              onFetchModels={(id) => void fetchModelList(id)}
              onBaseUrlChange={changeBaseUrl}
              onSaveBaseUrl={(id) => void saveBaseUrl(id)}
              customEdits={customEdits}
              onCustomEdit={editCustom}
              onRemoveProvider={(id) => void removeCustom(id)}
              onAddModel={(id, m) => void addModel(id, m)}
              onRemoveModel={(id, mid) => void removeModel(id, mid)}
            />
          </>
        )}
        {section === 'defaults' && <DefaultsSection mc={mc} onSetDefault={(k, key) => void setDefault(k, key)} />}
        {section === 'about' && (
          <>
            {/* 数据与目录 并入「关于」，减少一个一级分区 */}
            <AboutSection info={info} health={health} onRecheck={refresh} />
            <DataSection info={info} onOpen={(k) => void window.api.openPath(k)} />
          </>
        )}
      </div>

      <Modal
        title="添加服务商（OpenAI 兼容）"
        open={cpModal}
        onOk={() => void addCustomProvider()}
        onCancel={() => setCpModal(false)}
        okText="添加"
        cancelText="取消"
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Input
            className="fill-input"
            value={cpForm.name}
            onChange={(e) => setCpForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="名称（如：我的网关）"
          />
          <Input
            className="fill-input"
            value={cpForm.baseUrl}
            onChange={(e) => setCpForm((f) => ({ ...f, baseUrl: e.target.value }))}
            placeholder="API 地址（如 https://…/v1）"
          />
          <Input.Password
            className="fill-input"
            value={cpForm.key}
            onChange={(e) => setCpForm((f) => ({ ...f, key: e.target.value }))}
            placeholder="API Key（可留空，稍后补）"
          />
          <Typography.Text className="svc-hint">
            添加后在详情里「添加模型」填入模型 ID 与能力标签，创作页即可选用。
          </Typography.Text>
        </Space>
      </Modal>
    </div>
  )
}
