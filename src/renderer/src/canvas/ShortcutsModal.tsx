import type { JSX } from 'react'
import { Modal, Tag, Typography } from 'antd'

interface ShortcutGroup {
  title: string
  items: Array<{ keys: string[]; desc: string }>
}

const GROUPS: ShortcutGroup[] = [
  {
    title: '画布导航',
    items: [
      { keys: ['空格', '拖动'], desc: '平移画布（也可按住 Ctrl 临时平移）' },
      { keys: ['滚轮'], desc: '以光标为锚点缩放' },
      { keys: ['+', '-'], desc: '放大 / 缩小' },
      { keys: ['0'], desc: '复位到 100%' },
      { keys: ['F'], desc: '适配全部节点' },
      { keys: ['Shift', 'F'], desc: '聚焦选中的节点' }
    ]
  },
  {
    title: '选择与编辑',
    items: [
      { keys: ['拖动空白'], desc: '框选节点' },
      { keys: ['Shift', '点击'], desc: '增删选中' },
      { keys: ['Ctrl', 'A'], desc: '全选' },
      { keys: ['Ctrl', 'C'], desc: '复制选中' },
      { keys: ['Ctrl', 'V'], desc: '粘贴' },
      { keys: ['Ctrl', 'D'], desc: '复制副本' },
      { keys: ['Delete'], desc: '删除选中（节点优先，其次连线）' },
      { keys: ['Ctrl', 'Z'], desc: '撤销' },
      { keys: ['Ctrl', 'Shift', 'Z'], desc: '重做' }
    ]
  },
  {
    title: '拖动时',
    items: [
      { keys: ['Alt'], desc: '临时关闭吸附对齐' },
      { keys: ['Shift'], desc: '点选增删，不进入拖动' }
    ]
  }
]

/** 快捷键帮助面板（? 或工具条按钮打开）：画布快捷键已不少，需要一处可查 */
export default function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  return (
    <Modal open={open} onCancel={onClose} footer={null} title="画布快捷键" width={560}>
      {GROUPS.map((g) => (
        <div key={g.title} style={{ marginBottom: 16 }}>
          <Typography.Text strong>{g.title}</Typography.Text>
          <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>
            {g.items.map((it) => (
              <div key={it.desc} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ minWidth: 190 }}>
                  {it.keys.map((k, i) => (
                    <span key={k}>
                      {i > 0 && <span style={{ margin: '0 4px', color: '#94a3b8' }}>+</span>}
                      <Tag style={{ margin: 0, fontFamily: 'ui-monospace, monospace' }}>{k}</Tag>
                    </span>
                  ))}
                </span>
                <Typography.Text type="secondary">{it.desc}</Typography.Text>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Modal>
  )
}
