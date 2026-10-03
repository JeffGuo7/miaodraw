import type { JSX } from 'react'
import { useState } from 'react'
import { Alert, Button, Input, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd'
import {
  CheckOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  SyncOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import type { BailianKeyInfo, HealthInfo } from '../../types'
import { SectionHead } from './shared'

const PLAN_LABEL: Record<BailianKeyInfo['plan'], string> = {
  'token-plan': 'Token Plan 订阅密钥',
  ordinary: '普通 API Key',
  workspace: '工作空间密钥',
  unknown: '自定义密钥'
}

export default function StatusSection({
  health,
  bk,
  keyDraft,
  onKeyDraft,
  onSaveKey,
  onClearKey,
  onTest,
  testing,
  fetching,
  onFetchModels,
  onRecheck,
  wsInput,
  onWsInput,
  baseUrlInput,
  onBaseUrlInput,
  onSaveWs
}: {
  health: HealthInfo | null
  bk: BailianKeyInfo | null
  keyDraft: string
  onKeyDraft: (v: string) => void
  onSaveKey: () => void
  onClearKey: () => void
  onTest: () => void
  testing: boolean
  fetching: boolean
  onFetchModels: () => void
  onRecheck: () => Promise<void>
  wsInput: string
  onWsInput: (v: string) => void
  baseUrlInput: string
  onBaseUrlInput: (v: string) => void
  onSaveWs: () => void
}): JSX.Element {
  const [showKey, setShowKey] = useState(false)
  const [checking, setChecking] = useState(false)
  const ok = !!health?.ok

  return (
    <div className="sec">
      <SectionHead title="服务状态" desc="HTTP 直连引擎，无外部进程依赖；接入点与密钥保存后即时生效，无需重启。" />

      <div className={`status-bar${health ? (ok ? ' ok' : ' bad') : ''}`}>
        <span className="status-dot" />
        <div className="status-main">
          <div className="status-title">
            {health ? (ok ? '服务在线' : '服务离线（检查密钥与接入点）') : '检测中…'}
          </div>
          <div className="status-sub">{health?.entry || '—'}</div>
        </div>
        <Button
          icon={<SyncOutlined />}
          loading={checking}
          onClick={() => {
            setChecking(true)
            void onRecheck().finally(() => setChecking(false))
          }}
        >
          重新检测
        </Button>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <span className="stat-label">接入点</span>
          <span className="stat-value">
            <Typography.Text copyable style={{ fontSize: 13 }}>
              {health?.entry || '—'}
            </Typography.Text>
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">密钥</span>
          <span className="stat-value code">{bk?.configured ? bk.masked : '未配置'}</span>
        </div>
        <div className="stat">
          <span className="stat-label">鉴权方式</span>
          <span className="stat-value">
            {bk?.configured ? (
              <Tag color={bk.plan === 'token-plan' ? 'gold' : bk.plan === 'workspace' ? 'purple' : 'blue'}>
                {PLAN_LABEL[bk.plan]}
              </Tag>
            ) : (
              <Tag color="warning">未配置密钥</Tag>
            )}
          </span>
        </div>
      </div>

      {bk?.plainFallback && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="本机系统安全存储不可用，密钥为编码保存（仅本机可读），建议留意使用环境"
        />
      )}

      <div className="card-block">
        <div className="svc-field-head">
          <span className="svc-label">百炼 API 密钥</span>
          <a
            className="svc-link"
            href="https://bailian.console.aliyun.com/?apiKey=1#/api-key"
            target="_blank"
            rel="noreferrer"
          >
            获取密钥
          </a>
        </div>
        <div className="svc-key-row">
          <Input
            className="fill-input"
            type={showKey ? 'text' : 'password'}
            autoComplete="new-password"
            value={keyDraft}
            onChange={(e) => onKeyDraft(e.target.value)}
            onPressEnter={() => onSaveKey()}
            placeholder={
              bk?.configured
                ? `已保存 ${bk.masked}，粘贴新密钥可覆盖`
                : '粘贴百炼 API Key（sk-…）或 Token Plan 密钥（sk-sp-…）'
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
            <Tooltip title="保存并即时生效">
              <Button
                type="text"
                icon={<CheckOutlined />}
                disabled={!keyDraft.trim()}
                onClick={() => onSaveKey()}
              />
            </Tooltip>
            <Tooltip title="测试连通（拉取 /models，不消耗额度）">
              <Button type="text" icon={<ThunderboltOutlined />} loading={testing} onClick={() => onTest()} />
            </Tooltip>
            {bk?.configured && (
              <Popconfirm
                title="清除后生图 / 改图 / 反推将不可用。确认清除？"
                okText="清除"
                cancelText="取消"
                onConfirm={() => onClearKey()}
              >
                <Button type="text" danger title="清除密钥" icon={<DeleteOutlined />} />
              </Popconfirm>
            )}
          </div>
        </div>
        <Typography.Text className="svc-hint">
          支持普通 API Key（sk-）、工作空间密钥（sk-ws-，需填下方接入点）与 Token Plan 订阅密钥（sk-sp-）。密钥在本机加密保存，
          不会上传任何第三方。
        </Typography.Text>
      </div>

      <div className="card-block">
        <div className="svc-field-head">
          <span className="svc-label">工作空间 ID（可选）</span>
        </div>
        <div className="svc-line">
          <Input
            className="fill-input"
            value={wsInput}
            onChange={(e) => onWsInput(e.target.value)}
            onPressEnter={() => onSaveWs()}
            placeholder="例：llm-xxxxxxxx（sk-ws- 工作空间密钥必填，普通 sk- 留空）"
          />
        </div>
        <div className="svc-field-head" style={{ marginTop: 16 }}>
          <span className="svc-label">专属接入点 Base URL（可选）</span>
        </div>
        <div className="svc-line">
          <Input
            className="fill-input"
            value={baseUrlInput}
            onChange={(e) => onBaseUrlInput(e.target.value)}
            onPressEnter={() => onSaveWs()}
            placeholder="例：https://xxx.cn-beijing.maas.aliyuncs.com"
          />
        </div>
        <Space style={{ marginTop: 14 }}>
          <Button type="primary" onClick={() => onSaveWs()}>
            保存接入点
          </Button>
          <Button
            icon={<CloudDownloadOutlined />}
            loading={fetching}
            disabled={!bk?.configured}
            onClick={() => onFetchModels()}
          >
            拉取百炼模型列表
          </Button>
        </Space>
      </div>
    </div>
  )
}
