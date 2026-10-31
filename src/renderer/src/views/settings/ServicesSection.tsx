import type { JSX } from 'react'
import { useState } from 'react'
import { Button, Checkbox, Dropdown, Empty, Input, Modal, Popconfirm, Switch, Tooltip, Typography } from 'antd'
import {
  CheckOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FilterOutlined,
  InfoCircleOutlined,
  LockOutlined,
  PlusOutlined,
  SearchOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import type { ModelCap } from '../../types'
import { CAP_META, CAP_ORDER, CapPills, KEY_URLS, ProviderAvatar } from './shared'
import type { UiModel, UiProvider } from './shared'

interface AddModelPayload {
  id: string
  name: string
  caps: ModelCap[]
}

interface ServicesProps {
  providers: UiProvider[]
  selectedId: string
  onSelect: (id: string) => void
  search: string
  onSearch: (v: string) => void
  onAddProvider: () => void
  onToggle: (id: string, enabled: boolean) => void
  keyDrafts: Record<string, string>
  onKeyDraft: (id: string, v: string) => void
  onSaveKey: (id: string) => void
  onClearKey: (id: string) => void
  onTest: (id: string) => void
  testingId: string | null
  fetchingId: string | null
  onFetchModels: (id: string) => void
  onBaseUrlChange: (id: string, v: string) => void
  onSaveBaseUrl: (id: string) => void
  customEdits: Record<string, { name?: string; baseUrl?: string }>
  onCustomEdit: (id: string, patch: { name?: string; baseUrl?: string }) => void
  onRemoveProvider: (id: string) => void
  onAddModel: (id: string, m: AddModelPayload) => void
  onRemoveModel: (id: string, modelId: string) => void
}

export default function ServicesSection(props: ServicesProps): JSX.Element {
  const { providers, selectedId, onSelect, search, onSearch, onAddProvider } = props
  const q = search.trim().toLowerCase()
  const listed = q
    ? providers.filter(
        (p) => p.name.toLowerCase().includes(q) || p.models.some((m) => m.id.toLowerCase().includes(q))
      )
    : providers
  const selected = providers.find((p) => p.id === selectedId) ?? listed[0] ?? null

  return (
    <div className="svc">
      <div className="svc-list">
        <div className="svc-list-head">
          <div className="svc-list-title">
            <span>第三方服务商</span>
            <span className="svc-count">{providers.length} 个已启用 · 百炼在上方单独配置</span>
          </div>
          <Input
            className="fill-input"
            allowClear
            prefix={<SearchOutlined className="svc-search-icon" />}
            placeholder="搜索供应商或模型 ID…"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
        <div className="svc-list-body">
          {listed.map((p) => (
            <div
              key={p.id}
              className={`svc-item${selected?.id === p.id ? ' active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelect(p.id)
              }}
            >
              <ProviderAvatar id={p.id} name={p.name} size={32} />
              <span className={`svc-item-name${p.enabled ? '' : ' off'}`}>{p.name}</span>
              {!p.enabled && <span className="svc-badge">已停用</span>}
              <Tooltip title={p.configured ? '已配置密钥' : '未配置密钥'}>
                <span className={`svc-dot${p.configured ? ' on' : ''}`} />
              </Tooltip>
            </div>
          ))}
          {listed.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的供应商" />}
        </div>
        <div className="svc-list-foot">
          <Button block className="svc-add" icon={<PlusOutlined />} onClick={onAddProvider}>
            添加服务商
          </Button>
        </div>
      </div>
      <div className="svc-detail" key={selected?.id ?? 'none'}>
        {selected ? <ProviderDetail key={selected.id} provider={selected} {...props} /> : <NoProvider onAdd={onAddProvider} />}
      </div>
    </div>
  )
}

function NoProvider({ onAdd }: { onAdd: () => void }): JSX.Element {
  return (
    <div className="svc-empty">
      <ProviderAvatar id="miaodraw" name="妙" size={56} />
      <h3>还没有可用的服务商</h3>
      <p>添加一个 OpenAI 兼容的服务商（如自己的网关），填入密钥与模型 ID 即可用于创作。</p>
      <Button type="primary" icon={<PlusOutlined />} onClick={onAdd}>
        添加服务商
      </Button>
    </div>
  )
}

function ProviderDetail({
  provider,
  onToggle,
  keyDrafts,
  onKeyDraft,
  onSaveKey,
  onClearKey,
  onTest,
  testingId,
  fetchingId,
  onFetchModels,
  onBaseUrlChange,
  onSaveBaseUrl,
  customEdits,
  onCustomEdit,
  onRemoveProvider,
  onAddModel,
  onRemoveModel
}: ServicesProps & { provider: UiProvider }): JSX.Element {
  const [showKey, setShowKey] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [q, setQ] = useState('')
  const [capFilter, setCapFilter] = useState<ModelCap | 'all'>('all')
  const [draft, setDraft] = useState<AddModelPayload>({ id: '', name: '', caps: ['image'] })

  const draftKey = keyDrafts[provider.id] ?? ''
  const keyUrl = KEY_URLS[provider.id]
  const edit = customEdits[provider.id] ?? {}
  const customName = edit.name ?? provider.name
  const customBase = edit.baseUrl ?? provider.baseUrl
  const isCustom = provider.kind === 'custom'
  const customDirty = isCustom && (customName !== provider.name || customBase !== provider.baseUrl)
  const baseDirty = isCustom ? customDirty : provider.baseUrlDirty

  const mq = q.trim().toLowerCase()
  const models = provider.models.filter(
    (m) =>
      (capFilter === 'all' || m.caps.includes(capFilter)) &&
      (!mq || m.id.toLowerCase().includes(mq) || m.name.toLowerCase().includes(mq))
  )

  return (
    <>
      <div className="svc-head">
        <div className="svc-head-main">
          <h2 className="svc-provider-name">{provider.name}</h2>
          <Tooltip title={provider.note}>
            <InfoCircleOutlined className="svc-info" />
          </Tooltip>
          {provider.kind === 'builtin' && <span className="svc-kind">内置</span>}
        </div>
        <div className="svc-head-actions">
          {isCustom && (
            <Popconfirm
              title="删除该服务商及其密钥记录？"
              okText="删除"
              cancelText="取消"
              onConfirm={() => onRemoveProvider(provider.id)}
            >
              <Button type="text" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          )}
          <Tooltip title={provider.enabled ? '停用后在创作页与默认模型列表中隐藏' : '启用后可用于创作'}>
            <span className="svc-switch">
              <Switch className="green-switch" checked={provider.enabled} onChange={(v) => onToggle(provider.id, v)} />
            </span>
          </Tooltip>
        </div>
      </div>

      {isCustom && (
        <div className="svc-field">
          <div className="svc-field-head">
            <span className="svc-label">名称</span>
          </div>
          <div className="svc-line">
            <Input
              className="fill-input"
              value={customName}
              onChange={(e) => onCustomEdit(provider.id, { name: e.target.value })}
              placeholder="如：我的网关"
            />
          </div>
        </div>
      )}

      <div className="svc-field">
        <div className="svc-field-head">
          <span className="svc-label">API 密钥</span>
          {keyUrl && (
            <a className="svc-link" href={keyUrl} target="_blank" rel="noreferrer">
              获取密钥
            </a>
          )}
        </div>
        <div className="svc-key-row">
          <Input
            className="fill-input"
            type={showKey ? 'text' : 'password'}
            autoComplete="new-password"
            value={draftKey}
            onChange={(e) => onKeyDraft(provider.id, e.target.value)}
            onPressEnter={() => onSaveKey(provider.id)}
            placeholder={
              provider.configured ? `已保存 ${provider.masked}，粘贴新密钥可覆盖` : `粘贴 ${provider.name} 的 API Key`
            }
          />
          <div className="svc-key-actions">
            <Tooltip title={showKey ? '隐藏' : '显示'}>
              <Button
                type="text"
                icon={showKey ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                onClick={() => setShowKey((v) => !v)}
              />
            </Tooltip>
            <Tooltip title="保存密钥">
              <Button
                type="text"
                icon={<CheckOutlined />}
                disabled={!draftKey.trim()}
                onClick={() => onSaveKey(provider.id)}
              />
            </Tooltip>
            <Tooltip title="测试连通（拉取 /models，不消耗额度）">
              <Button
                type="text"
                icon={<ThunderboltOutlined />}
                loading={testingId === provider.id}
                onClick={() => onTest(provider.id)}
              />
            </Tooltip>
            {provider.configured && (
              <Popconfirm
                title="清除后该服务商不可用。确认清除？"
                okText="清除"
                cancelText="取消"
                onConfirm={() => onClearKey(provider.id)}
              >
                <Button type="text" danger title="清除密钥" icon={<DeleteOutlined />} />
              </Popconfirm>
            )}
          </div>
        </div>
        {provider.plainFallback && (
          <Typography.Text className="svc-warn">
            本机系统安全存储不可用，密钥以编码形式保存（仅本机可读）
          </Typography.Text>
        )}
      </div>

      <div className="svc-field">
        <div className="svc-field-head">
          <span className="svc-label">API 地址</span>
          {provider.baseUrlEditable && baseDirty && (
            <Button type="link" size="small" className="svc-link" onClick={() => onSaveBaseUrl(provider.id)}>
              保存
            </Button>
          )}
        </div>
        <div className="svc-line">
          <Input
            className="fill-input"
            value={provider.baseUrlEditable ? (isCustom ? customBase : provider.baseUrl) : provider.baseUrl}
            disabled={!provider.baseUrlEditable}
            onChange={(e) => onBaseUrlChange(provider.id, e.target.value)}
            onPressEnter={() => {
              if (baseDirty) onSaveBaseUrl(provider.id)
            }}
            placeholder="https://…/v1（OpenAI 兼容根地址）"
            suffix={
              provider.baseUrlEditable ? undefined : (
                <Tooltip title="内置固定端点，不可修改">
                  <LockOutlined className="svc-lock" />
                </Tooltip>
              )
            }
          />
        </div>
      </div>

      <div className="svc-block">
        <div className="model-toolbar">
          <span className="svc-label">模型</span>
          <Input
            className="fill-input model-search"
            allowClear
            prefix={<SearchOutlined className="svc-search-icon" />}
            placeholder="搜索模型"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Dropdown
            trigger={['click']}
            menu={{
              selectable: true,
              selectedKeys: [capFilter],
              items: [
                { key: 'all', label: '全部能力' },
                ...CAP_ORDER.map((c) => ({ key: c, label: CAP_META[c].label }))
              ],
              onClick: ({ key }) => setCapFilter(key as ModelCap | 'all')
            }}
          >
            <Button
              type="text"
              className={capFilter === 'all' ? '' : 'active-filter'}
              title="按能力筛选"
              icon={<FilterOutlined />}
            />
          </Dropdown>
          <span className="model-toolbar-gap" />
          <Tooltip title={provider.configured ? '从服务端 /models 自动发现模型' : '先保存密钥'}>
            <span>
              <Button
                icon={<CloudDownloadOutlined />}
                loading={fetchingId === provider.id}
                disabled={!provider.configured}
                onClick={() => onFetchModels(provider.id)}
              >
                拉取模型列表
              </Button>
            </span>
          </Tooltip>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
            添加模型
          </Button>
        </div>

        <div className="model-box">
          {models.map((m) => (
            <ModelRow key={`${m.source}-${m.id}`} model={m} onRemove={() => onRemoveModel(provider.id, m.id)} />
          ))}
          {models.length === 0 && (
            <div className="model-empty">
              {provider.models.length === 0
                ? '该服务商还没有模型，点「添加模型」或「拉取模型列表」'
                : '没有匹配的模型'}
            </div>
          )}
        </div>
      </div>

      <Modal
        title={`添加模型 · ${provider.name}`}
        open={addOpen}
        okText="添加"
        cancelText="取消"
        okButtonProps={{ disabled: !draft.id.trim() }}
        onCancel={() => setAddOpen(false)}
        onOk={() => {
          onAddModel(provider.id, draft)
          setAddOpen(false)
          setDraft({ id: '', name: '', caps: ['image'] })
        }}
      >
        <div className="svc-modal-field">
          <span className="svc-label">模型 ID</span>
          <Input
            className="fill-input"
            autoFocus
            value={draft.id}
            onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
            placeholder="如 qwen-image-4"
          />
        </div>
        <div className="svc-modal-field">
          <span className="svc-label">显示名（可空）</span>
          <Input
            className="fill-input"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="留空则用模型 ID"
          />
        </div>
        <div className="svc-modal-field">
          <span className="svc-label">能力</span>
          <Checkbox.Group
            options={CAP_ORDER.map((c) => ({ value: c, label: CAP_META[c].label }))}
            value={draft.caps}
            onChange={(vs) => setDraft((d) => ({ ...d, caps: vs as ModelCap[] }))}
          />
        </div>
        <Typography.Text className="svc-hint">添加后创作页即可选用；能力决定它出现在哪类默认模型下拉里。</Typography.Text>
      </Modal>
    </>
  )
}

function ModelRow({ model, onRemove }: { model: UiModel; onRemove: () => void }): JSX.Element {
  return (
    <div className="model-row">
      <span className={`model-avatar src-${model.source}`}>{model.id.slice(0, 1).toUpperCase()}</span>
      <span className="model-name">{model.name}</span>
      {model.name !== model.id && <span className="model-id">{model.id}</span>}
      <span className="model-toolbar-gap" />
      <CapPills caps={model.caps} />
      {model.deletable ? (
        <Tooltip title="移除该模型">
          <Button type="text" className="model-del" icon={<DeleteOutlined />} onClick={onRemove} />
        </Tooltip>
      ) : (
        <Tooltip title="内置模型，不可移除">
          <LockOutlined className="svc-lock" />
        </Tooltip>
      )}
    </div>
  )
}
