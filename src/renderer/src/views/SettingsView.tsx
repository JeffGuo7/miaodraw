import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import {
  App as AntdApp,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  DeleteOutlined,
  FolderOpenOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  CloudDownloadOutlined
} from '@ant-design/icons'
import type { BailianKeyInfo, HealthInfo, ModelCap, ModelConfig, ProviderKeyInfo } from '../types'
import { byCap, modelKey, PROVIDERS, resolveModels } from '../models'

export default function SettingsView({ visible }: { visible: boolean }): JSX.Element {
  const { message } = AntdApp.useApp()
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [info, setInfo] = useState<{ version: string; name: string; libraryRoot: string; outputsDir: string } | null>(null)
  const [fetching, setFetching] = useState<string | null>(null)
  const [pkInfo, setPkInfo] = useState<Record<string, ProviderKeyInfo>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [mc, setMc] = useState<ModelConfig>({})
  // 追加模型的行内草稿：key = 供应商 id
  const [extraDraft, setExtraDraft] = useState<Record<string, { id: string; name: string; caps: ModelCap[] }>>({})
  // 自定义供应商追加模型的行内草稿
  const [cpModelDraft, setCpModelDraft] = useState<Record<string, { id: string; name: string; caps: ModelCap[] }>>({})
  const [cpModal, setCpModal] = useState(false)
  const [cpForm, setCpForm] = useState<{ name: string; baseUrl: string; key: string }>({ name: '', baseUrl: '', key: '' })
  const [bk, setBk] = useState<BailianKeyInfo | null>(null)
  const [bkInput, setBkInput] = useState('')
  const [bkTesting, setBkTesting] = useState(false)
  const [wsInput, setWsInput] = useState('')
  const [baseUrlInput, setBaseUrlInput] = useState('')

  function refresh(): void {
    void window.api.health().then(setHealth)
    void window.api.appInfo().then(setInfo)
    void window.api.bailianKeyGet().then(setBk).catch(() => undefined)
    void window.api.providerKeyGet().then(setPkInfo).catch(() => undefined)
    void window.api.modelConfigGet().then(setMc).catch(() => undefined)
    void window.api
      .getSettings()
      .then((s) => {
        const adv = s as { bailianWorkspace?: string; bailianBaseUrl?: string }
        setWsInput(adv.bailianWorkspace ?? '')
        setBaseUrlInput(adv.bailianBaseUrl ?? '')
      })
      .catch(() => undefined)
  }

  useEffect(() => {
    if (visible) refresh()
  }, [visible])

  async function saveBailianKey(): Promise<void> {
    const r = await window.api.bailianKeySet(bkInput.trim())
    if (!r.ok) {
      message.error(r.err)
      return
    }
    setBk(r.info)
    setBkInput('')
    if (r.plainFallback) message.warning('已保存，但本机系统安全存储不可用，密钥以编码形式保存（仅本机能读，建议尽快改用登录态）')
    else message.success('百炼密钥已加密保存，立即可用（无需 bl auth login）')
    void window.api.health().then(setHealth)
  }

  async function testBailianKey(): Promise<void> {
    setBkTesting(true)
    try {
      const r = await window.api.bailianKeyTest()
      if (r.ok) message.success(r.out)
      else message.error(`测试失败：${r.out}`)
    } finally {
      setBkTesting(false)
    }
  }

  async function clearBailianKey(): Promise<void> {
    setBk(await window.api.bailianKeyClear())
    message.success('已清除应用内百炼密钥')
    void window.api.health().then(setHealth)
  }

  async function saveWorkspace(): Promise<void> {
    await window.api.bailianWsSet({ ws: wsInput.trim(), baseUrl: baseUrlInput.trim() })
    message.success('工作空间 / 接入点已保存并即时生效')
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
  }

  async function clearProviderKey(provider: string): Promise<void> {
    const r = await window.api.providerKeyClear(provider)
    if (r.ok) {
      setPkInfo(r.info)
      message.success('已清除该服务商密钥')
    } else {
      message.error(r.err)
    }
  }

  // ---------- 通用模型配置管理 ----------
  const CAP_OPTS: Array<{ value: ModelCap; label: string }> = [
    { value: 'image', label: '生图' },
    { value: 'text', label: '文本' },
    { value: 'vision', label: '视觉' }
  ]
  const CAP_LABEL: Record<ModelCap, string> = { image: '生图', text: '文本', vision: '视觉' }

  async function saveConfig(next: ModelConfig): Promise<void> {
    const saved = await window.api.modelConfigSet(next)
    setMc(saved as ModelConfig)
  }

  async function addExtraModel(providerId: string): Promise<void> {
    const d = extraDraft[providerId]
    if (!d?.id?.trim()) {
      message.warning('请填写模型 ID')
      return
    }
    const providers = { ...mc.extraModels }
    const list = [...(providers[providerId] ?? [])]
    if (list.some((m) => m.id === d.id.trim())) {
      message.warning('该模型 ID 已存在')
      return
    }
    list.push({ id: d.id.trim(), name: d.name?.trim() || d.id.trim(), caps: d.caps.length ? d.caps : ['image'] })
    providers[providerId] = list
    await saveConfig({ ...mc, extraModels: providers })
    setExtraDraft((s) => ({ ...s, [providerId]: { id: '', name: '', caps: ['image' as ModelCap] } }))
    message.success('模型已添加，创作页即可选用')
  }

  async function removeExtraModel(providerId: string, modelId: string): Promise<void> {
    const providers = { ...mc.extraModels }
    providers[providerId] = (providers[providerId] ?? []).filter((m) => m.id !== modelId)
    await saveConfig({ ...mc, extraModels: providers })
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
    message.success('自定义供应商已添加，记得在其下添加模型')
  }

  async function updateCustom(id: string, patch: { name?: string; baseUrl?: string; enabled?: boolean }): Promise<void> {
    await saveConfig({
      ...mc,
      customProviders: (mc.customProviders ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c))
    })
  }

  async function removeCustom(id: string): Promise<void> {
    await saveConfig({ ...mc, customProviders: (mc.customProviders ?? []).filter((c) => c.id !== id) })
    await window.api.providerKeyClear(id)
    message.success('已删除该自定义供应商')
  }

  async function addCustomModel(cpId: string): Promise<void> {
    const d = cpModelDraft[cpId]
    if (!d?.id?.trim()) {
      message.warning('请填写模型 ID')
      return
    }
    const next = (mc.customProviders ?? []).map((c) => {
      if (c.id !== cpId) return c
      if (c.models.some((m) => m.id === d.id.trim())) {
        message.warning('该模型 ID 已存在')
        return c
      }
      return { ...c, models: [...c.models, { id: d.id.trim(), name: d.name?.trim() || d.id.trim(), caps: d.caps.length ? d.caps : (['image'] as ModelCap[]) }] }
    })
    await saveConfig({ ...mc, customProviders: next })
    setCpModelDraft((s) => ({ ...s, [cpId]: { id: '', name: '', caps: ['image' as ModelCap] } }))
  }

  async function removeCustomModel(cpId: string, modelId: string): Promise<void> {
    const next = (mc.customProviders ?? []).map((c) =>
      c.id === cpId ? { ...c, models: c.models.filter((m) => m.id !== modelId) } : c
    )
    await saveConfig({ ...mc, customProviders: next })
  }

  async function setDefault(kind: 'image' | 'text' | 'vision', key: string): Promise<void> {
    await saveConfig({ ...mc, defaults: { ...mc.defaults, [kind]: key } })
    message.success('默认模型已更新')
  }

  async function testProvider(provider: string): Promise<void> {
    setTesting(provider)
    try {
      const r = await window.api.testProvider(provider)
      if (r.ok) message.success(r.out)
      else message.error(`测试失败：${r.out}`)
    } finally {
      setTesting(null)
    }
  }

  /** 从服务端 /models 拉取模型目录并入库（Cherry Studio 式自动发现） */
  async function fetchModelList(provider: string): Promise<void> {
    setFetching(provider)
    try {
      const r = await window.api.fetchModels(provider)
      if (r.ok) {
        message.success(`已拉取 ${r.models} 个模型（服务端共 ${r.total} 个，已过滤语音/向量等无关模型）`)
        void window.api.modelConfigGet().then((cfg) => setMc(cfg))
      } else {
        message.error(`拉取失败：${r.out}`)
      }
    } finally {
      setFetching(null)
    }
  }

  return (
    <div className="settings-wrap">
      <Card
        title={
          <Space size={8}>
            <KeyOutlined />
            <span>百炼密钥（免登录直接使用）</span>
            {bk?.configured && (
              <Tag color={bk.plan === 'token-plan' ? 'gold' : bk.plan === 'workspace' ? 'purple' : 'blue'} style={{ marginInlineStart: 4 }}>
                {bk.plan === 'token-plan' ? 'Token Plan 订阅密钥' : bk.plan === 'workspace' ? '工作空间密钥' : bk.plan === 'ordinary' ? '普通 API Key' : '自定义密钥'}
              </Tag>
            )}
          </Space>
        }
        styles={{ body: { padding: 16 } }}
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
          填入密钥后，妙绘通过 <strong>HTTP 直连</strong>调用百炼生图 / 改图 / 提示词反推，无需安装任何命令行工具。
          支持普通 API Key（<Typography.Text code>sk-</Typography.Text> 开头）、工作空间密钥（
          <Typography.Text code>sk-ws-</Typography.Text> 开头，需在下方填写专属接入点）与
          Token Plan 订阅密钥（<Typography.Text code>sk-sp-</Typography.Text> 开头）。密钥在本机加密保存，不会上传任何第三方。
        </Typography.Paragraph>
        {bk?.configured ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Descriptions column={1} size="small" style={{ marginBottom: 0 }}>
              <Descriptions.Item label="当前密钥">
                <Typography.Text code>{bk.masked}</Typography.Text>
              </Descriptions.Item>
            </Descriptions>
            {bk.plainFallback && (
              <Alert
                type="warning"
                showIcon
                message="本机系统安全存储不可用，密钥为编码保存（仅本机可读），建议留意使用环境"
              />
            )}
            <Space wrap>
              <Button icon={<ReloadOutlined />} loading={bkTesting} onClick={() => void testBailianKey()}>
                测试连通
              </Button>
              <Popconfirm title="清除后生图 / 改图 / 反推将不可用。确认清除？" okText="清除" onConfirm={() => void clearBailianKey()}>
                <Button danger icon={<DeleteOutlined />}>
                  清除密钥
                </Button>
              </Popconfirm>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                更换密钥：在下方填入新密钥并保存即可覆盖
              </Typography.Text>
            </Space>
          </Space>
        ) : (
          <Space.Compact style={{ width: '100%', maxWidth: 640 }}>
            <Input.Password
              value={bkInput}
              onChange={(e) => setBkInput(e.target.value)}
              placeholder="粘贴百炼 API Key（sk-…）或 Token Plan 密钥（sk-sp-…）"
              visibilityToggle
              onPressEnter={() => bkInput.trim() && void saveBailianKey()}
            />
            <Button type="primary" disabled={!bkInput.trim()} onClick={() => void saveBailianKey()}>
              保存
            </Button>
          </Space.Compact>
        )}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
          密钥获取：登录百炼控制台，在「API-KEY 管理」下载普通密钥，或在业务空间详情页创建工作空间密钥（sk-ws-）。
          保存后所有百炼调用自动使用该密钥；清除后生图与反推将提示补全密钥。
        </Typography.Paragraph>
        <div style={{ marginTop: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            工作空间 ID（可选 · <Typography.Text code>o1_</Typography.Text>/<Typography.Text code>sk-ws-</Typography.Text> 工作空间密钥必填，控制台「命令行接入」里可查；普通 sk- 密钥留空）
          </Typography.Text>
          <Space.Compact style={{ width: '100%', maxWidth: 640, marginTop: 6 }}>
            <Input
              value={wsInput}
              onChange={(e) => setWsInput(e.target.value)}
              placeholder="例：llm-xxxxxxxx"
              onPressEnter={() => void saveWorkspace()}
            />
            <Button onClick={() => void saveWorkspace()}>保存</Button>
          </Space.Compact>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
            专属接入点 Base URL（可选 · 工作空间专用密钥 sk-ws- 需填写 CSV 里的 dashScope 地址）
          </Typography.Text>
          <Space.Compact style={{ width: '100%', maxWidth: 640, marginTop: 6 }}>
            <Input
              value={baseUrlInput}
              onChange={(e) => setBaseUrlInput(e.target.value)}
              placeholder="例：https://xxx.cn-beijing.maas.aliyuncs.com/api/v1"
              onPressEnter={() => void saveWorkspace()}
            />
            <Button onClick={() => void saveWorkspace()}>保存</Button>
          </Space.Compact>
        </div>
      </Card>

      <Card title="模型服务" styles={{ body: { padding: 16 } }} style={{ marginTop: 16 }}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
          Cherry Studio 式通用配置：供应商 → 模型条目（带能力标签）→ 按能力设默认。全部供应商均为
          HTTP 直连（百炼走官方 DashScope/OpenAI 兼容协议，其余为 OpenAI 兼容端点），填 Key 即可启用，也可添加自己的网关。
          「拉取模型」会从服务端自动发现模型目录。密钥一律本机加密，只显示掩码。
        </Typography.Paragraph>
        {PROVIDERS.map((p) => {
          const info = pkInfo[p.id]
          const configured = !!info?.configured
          const extras = mc.extraModels?.[p.id] ?? []
          const fetched = mc.fetchedModels?.[p.id] ?? []
          const d = extraDraft[p.id] ?? { id: '', name: '', caps: ['image' as ModelCap] }
          return (
            <div key={p.id} className="provider-row" style={{ marginBottom: 14 }}>
              <div className="provider-head">
                <Badge status={configured ? 'success' : 'default'} text={<Typography.Text strong>{p.label}</Typography.Text>} />
                {configured && info.masked && (
                  <Typography.Text code style={{ fontSize: 12 }}>
                    {info.masked}
                  </Typography.Text>
                )}
                <Typography.Text type="secondary" className="provider-note">
                  {p.note}
                </Typography.Text>
                <Button
                  size="small"
                  icon={<CloudDownloadOutlined />}
                  loading={fetching === p.id}
                  disabled={!configured}
                  onClick={() => void fetchModelList(p.id)}
                >
                  拉取模型
                </Button>
              </div>
              {p.id !== 'bailian' && (
                <Space.Compact style={{ width: '100%', maxWidth: 560, marginBottom: 8 }}>
                  <Input.Password
                    value={drafts[p.id] ?? ''}
                    onChange={(e) => setDrafts((dd) => ({ ...dd, [p.id]: e.target.value }))}
                    placeholder={configured ? '已保存（掩码），粘贴新密钥覆盖' : `${p.label} API Key`}
                    visibilityToggle
                    onPressEnter={() => drafts[p.id]?.trim() && void saveProviderKey(p.id)}
                  />
                  <Button type="primary" disabled={!drafts[p.id]?.trim()} onClick={() => void saveProviderKey(p.id)}>
                    保存
                  </Button>
                  <Button loading={testing === p.id} onClick={() => void testProvider(p.id)}>
                    测试
                  </Button>
                  {configured && (
                    <Popconfirm title="清除后需重新输入密钥。确认清除？" okText="清除" onConfirm={() => void clearProviderKey(p.id)}>
                      <Button danger icon={<DeleteOutlined />}>
                        清除
                      </Button>
                    </Popconfirm>
                  )}
                </Space.Compact>
              )}
              <div style={{ marginBottom: 6 }}>
                {(p.models.map((m) => ({ ...m, extra: false })) .concat(extras.map((m) => ({ model: m.id, label: m.name, price: '按量', extra: true })))).map((m) => (
                  <Tag
                    key={m.model}
                    closable={m.extra}
                    onClose={() => void removeExtraModel(p.id, m.model)}
                    style={{ marginInlineEnd: 6 }}
                  >
                    {m.label}
                  </Tag>
                ))}
                {fetched.length > 0 && (
                  <Tooltip title="来自服务端 /models 自动发现；再次「拉取模型」会刷新">
                    <span>
                      {fetched.map((id) => (
                        <Tag key={`f-${id}`} color="default" style={{ marginInlineEnd: 6, borderStyle: 'dashed' }}>
                          {id}
                        </Tag>
                      ))}
                    </span>
                  </Tooltip>
                )}
              </div>
              <Space.Compact style={{ width: '100%', maxWidth: 640 }}>
                <Input
                  value={d.id}
                  onChange={(e) => setExtraDraft((s) => ({ ...s, [p.id]: { ...d, id: e.target.value } }))}
                  placeholder="模型 ID（如 qwen-image-4）"
                  style={{ maxWidth: 240 }}
                />
                <Input
                  value={d.name}
                  onChange={(e) => setExtraDraft((s) => ({ ...s, [p.id]: { ...d, name: e.target.value } }))}
                  placeholder="显示名（可空）"
                  style={{ maxWidth: 160 }}
                />
                <Checkbox.Group
                  options={CAP_OPTS}
                  value={d.caps}
                  onChange={(vs) => setExtraDraft((s) => ({ ...s, [p.id]: { ...d, caps: vs as ModelCap[] } }))}
                />
                <Button icon={<PlusOutlined />} disabled={!d.id.trim()} onClick={() => void addExtraModel(p.id)}>
                  添加
                </Button>
              </Space.Compact>
            </div>
          )
        })}

        <div style={{ borderTop: '1px solid #f0f0f0', margin: '12px 0', paddingTop: 12 }}>
          <Space style={{ marginBottom: 10 }}>
            <Typography.Text strong>自定义供应商（OpenAI 兼容）</Typography.Text>
            <Button size="small" icon={<PlusOutlined />} onClick={() => setCpModal(true)}>
              添加
            </Button>
          </Space>
          {(mc.customProviders ?? []).map((c) => {
            const info = pkInfo[c.id]
            const configured = !!info?.configured
            const md = cpModelDraft[c.id] ?? { id: '', name: '', caps: ['image' as ModelCap] }
            return (
              <div key={c.id} className="provider-row" style={{ marginBottom: 14, padding: 10, background: '#fafafa', borderRadius: 8 }}>
                <div className="provider-head">
                  <Switch size="small" checked={c.enabled} onChange={(v) => void updateCustom(c.id, { enabled: v })} />
                  <Typography.Text strong>{c.name}</Typography.Text>
                  {configured && (
                    <Typography.Text code style={{ fontSize: 12 }}>
                      {pkInfo[c.id]?.masked}
                    </Typography.Text>
                  )}
                  <Popconfirm title="删除该供应商及其密钥记录？" okText="删除" onConfirm={() => void removeCustom(c.id)}>
                    <Button danger size="small" icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </div>
                <Space.Compact style={{ width: '100%', maxWidth: 640, marginBlock: 6 }}>
                  <Input
                    value={c.name}
                    onChange={(e) => void updateCustom(c.id, { name: e.target.value })}
                    placeholder="名称"
                    style={{ maxWidth: 140 }}
                  />
                  <Input
                    value={c.baseUrl}
                    onChange={(e) => void updateCustom(c.id, { baseUrl: e.target.value })}
                    placeholder="https://…/v1（OpenAI 兼容根地址）"
                  />
                  <Button onClick={() => void updateCustom(c.id, { name: c.name, baseUrl: c.baseUrl })}>保存地址</Button>
                </Space.Compact>
                <div style={{ marginBottom: 6 }}>
                  <Space.Compact style={{ width: '100%', maxWidth: 560 }}>
                    <Input.Password
                      value={drafts[c.id] ?? ''}
                      onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                      placeholder={configured ? '已保存（掩码），粘贴新密钥覆盖' : 'API Key（可空）'}
                      visibilityToggle
                    />
                    <Button
                      type="primary"
                      disabled={!drafts[c.id]?.trim()}
                      onClick={() => void saveProviderKey(c.id)}
                    >
                      保存
                    </Button>
                    {configured && (
                      <Popconfirm title="清除该密钥？" okText="清除" onConfirm={() => void clearProviderKey(c.id)}>
                        <Button danger icon={<DeleteOutlined />}>
                          清除
                        </Button>
                      </Popconfirm>
                    )}
                  </Space.Compact>
                </div>
                <div style={{ marginBottom: 6 }}>
                  {c.models.map((m) => (
                    <Tag key={m.id} closable onClose={() => void removeCustomModel(c.id, m.id)}>
                      {m.name || m.id} · {m.caps.map((x) => CAP_LABEL[x]).join('/')}
                    </Tag>
                  ))}
                </div>
                <Space.Compact style={{ width: '100%', maxWidth: 640 }}>
                  <Input
                    value={md.id}
                    onChange={(e) => setCpModelDraft((s) => ({ ...s, [c.id]: { ...md, id: e.target.value } }))}
                    placeholder="模型 ID"
                    style={{ maxWidth: 240 }}
                  />
                  <Input
                    value={md.name}
                    onChange={(e) => setCpModelDraft((s) => ({ ...s, [c.id]: { ...md, name: e.target.value } }))}
                    placeholder="显示名（可空）"
                    style={{ maxWidth: 160 }}
                  />
                  <Checkbox.Group
                    options={CAP_OPTS}
                    value={md.caps}
                    onChange={(vs) => setCpModelDraft((s) => ({ ...s, [c.id]: { ...md, caps: vs as ModelCap[] } }))}
                  />
                  <Button icon={<PlusOutlined />} disabled={!md.id.trim()} onClick={() => void addCustomModel(c.id)}>
                    添加
                  </Button>
                </Space.Compact>
              </div>
            )
          })}
        </div>
      </Card>

      <Card title="默认模型（按能力）" styles={{ body: { padding: 16 } }} style={{ marginTop: 16 }}>
        {(() => {
          const cat = resolveModels(mc)
          const defaultsNow = mc.defaults ?? {}
          const optionFor = (kind: 'image' | 'text' | 'vision') => {
            const list = byCap(cat, kind)
            const cur = defaultsNow[kind]
            return {
              options: list.map((m) => ({ value: modelKey(m.provider, m.model), label: `${m.label} · ${m.provider}` })),
              value: cur ?? (list[0] ? modelKey(list[0].provider, list[0].model) : undefined)
            }
          }
          const mk = (kind: 'image' | 'text' | 'vision', label: string, hint: string) => {
            const o = optionFor(kind)
            return (
              <div style={{ marginBottom: 12 }}>
                <Typography.Text className="field-label">
                  {label} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text>
                </Typography.Text>
                <Select
                  style={{ width: '100%', maxWidth: 560, display: 'block' }}
                  value={o.value}
                  options={o.options}
                  onChange={(v) => void setDefault(kind, String(v))}
                  placeholder="选择模型"
                />
              </div>
            )
          }
          return (
            <>
              {mk('image', '生图默认', '创作页与 Agent 出图步骤使用')}
              {mk('text', '大语言模型默认', 'AI 助手规划指令时使用')}
              {mk('vision', '视觉默认', '提示词反推 / 图片理解使用')}
            </>
          )
        })()}
      </Card>

      <Modal
        title="添加自定义供应商（OpenAI 兼容）"
        open={cpModal}
        onOk={() => void addCustomProvider()}
        onCancel={() => setCpModal(false)}
        okText="添加"
        cancelText="取消"
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Input value={cpForm.name} onChange={(e) => setCpForm((f) => ({ ...f, name: e.target.value }))} placeholder="名称（如：我的网关）" />
          <Input value={cpForm.baseUrl} onChange={(e) => setCpForm((f) => ({ ...f, baseUrl: e.target.value }))} placeholder="API 地址（如 https://…/v1）" />
          <Input.Password value={cpForm.key} onChange={(e) => setCpForm((f) => ({ ...f, key: e.target.value }))} placeholder="API Key（可留空，稍后在列表里补）" visibilityToggle />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            添加后在其条目里添加模型 ID 与能力标签，创作页即可选用。
          </Typography.Text>
        </Space>
      </Modal>

      <Card title="服务状态（HTTP 直连引擎）" styles={{ body: { padding: 16 } }} style={{ marginTop: 16 }}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="状态">
            <Badge
              status={health ? (health.ok ? 'success' : 'error') : 'default'}
              text={health ? (health.ok ? `在线 · ${health.version}` : '离线（检查密钥与接入点）') : '检测中…'}
            />
          </Descriptions.Item>
          <Descriptions.Item label="鉴权">
            {bk?.configured ? (
              <Tag color="success">应用内百炼密钥（{bk.plan === 'workspace' ? '工作空间' : bk.plan === 'token-plan' ? 'Token Plan' : '普通'}）</Tag>
            ) : (
              <Tag color="warning">未配置密钥</Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="接入点">
            <Typography.Text copyable style={{ fontSize: 12 }}>
              {health?.entry || '—'}
            </Typography.Text>
          </Descriptions.Item>
        </Descriptions>
        <Space style={{ marginTop: 12 }}>
          <Button icon={<ReloadOutlined />} loading={bkTesting} onClick={() => void testBailianKey()}>
            测试连通
          </Button>
          <Button
            icon={<CloudDownloadOutlined />}
            loading={fetching === 'bailian'}
            disabled={!bk?.configured}
            onClick={() => void fetchModelList('bailian')}
          >
            拉取百炼模型目录
          </Button>
        </Space>
        <Typography.Paragraph type="secondary" className="tip-text" style={{ marginBottom: 0 }}>
          纯 HTTP 直连，无外部进程依赖；接入点与密钥保存后即时生效，无需重启
        </Typography.Paragraph>
      </Card>

      <Card title="数据目录" styles={{ body: { padding: 16 } }} style={{ marginTop: 16 }}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="作品目录">
            <Typography.Text copyable style={{ fontSize: 12 }}>
              {info?.outputsDir || '—'}
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="案例库">
            <Typography.Text copyable style={{ fontSize: 12 }}>
              {info?.libraryRoot || '—'}
            </Typography.Text>
          </Descriptions.Item>
        </Descriptions>
        <Space style={{ marginTop: 12 }}>
          <Button icon={<FolderOpenOutlined />} onClick={() => void window.api.openPath('outputs')}>
            打开作品目录
          </Button>
          <Button icon={<FolderOpenOutlined />} onClick={() => void window.api.openPath('library')}>
            打开案例库
          </Button>
        </Space>
      </Card>

      <Card title="关于" styles={{ body: { padding: 16 } }} style={{ marginTop: 16 }}>
        <Space direction="vertical" size={2}>
          <Typography.Text>妙绘工作台 v{info?.version ?? '…'}</Typography.Text>
          <Typography.Text type="secondary">AI 图像创作客户端 · 多服务商模型 · 阿里云百炼 / 硅基流动 / OpenAI</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Electron + React + Ant Design · 灵感：Cherry Studio / LobeChat
          </Typography.Text>
        </Space>
        <Button size="small" icon={<ReloadOutlined />} style={{ marginLeft: 12 }} onClick={refresh}>
          重新检测
        </Button>
      </Card>
    </div>
  )
}
