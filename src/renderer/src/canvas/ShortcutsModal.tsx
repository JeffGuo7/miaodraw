import type { JSX } from 'react'
import { Modal, Tag, Typography } from 'antd'

interface ShortcutGroup {
  title: string
  items: Array<{ keys: string[]; desc: string }>
}

/** 平台化修饰键：macOS 显示 ⌘，其它显示 Ctrl（同一份声明驱动展示，避免和实现漂移） */
const MOD = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'

const GROUPS: Array<ShortcutGroup | ((mod: string) => ShortcutGroup)> = [
  {
    title: '画布导航',
    items: [
      { keys: ['空格', '拖动'], desc: '临时平移画布（中键拖动同样可以）' },
      { keys: ['滚轮'], desc: '以光标为锚点缩放（触控板双指为平移）' },
      { keys: ['+', '−'], desc: '放大 / 缩小' },
      { keys: ['0'], desc: '回到 100%' },
      { keys: ['F'], desc: '适配全部节点' },
      { keys: ['Shift', 'F'], desc: '聚焦选中的节点' },
      { keys: ['V'], desc: '选择工具' },
      { keys: ['H'], desc: '抓手工具' }
    ]
  },
  {
    title: '创建与连线',
    items: [
      { keys: ['N'], desc: '在视口中心新建节点' },
      { keys: ['双击空白'], desc: '在落点新建节点' },
      { keys: ['单击端口'], desc: '新建下游节点并自动连线' },
      { keys: ['拖端口'], desc: '拖到目标节点连线；拖到空白处松手可新建并连线' }
    ]
  },
  (mod) => ({
    title: '选择与编辑',
    items: [
      { keys: ['拖动空白'], desc: '框选节点' },
      { keys: ['Shift', '点击'], desc: '增删选中' },
      { keys: [mod, 'A'], desc: '全选' },
      { keys: [mod, 'C'], desc: '复制选中' },
      { keys: [mod, 'V'], desc: '粘贴' },
      { keys: [mod, 'D'], desc: '复制副本' },
      { keys: ['方向键'], desc: '微移 1px（Shift 为 10px）' },
      { keys: ['Delete'], desc: '删除选中（有选中连线时先删连线）' },
      { keys: ['Esc'], desc: '关闭浮层 / 取消选择（逐层退出）' },
      { keys: [mod, 'Z'], desc: '撤销' },
      { keys: [mod, 'Shift', 'Z'], desc: '重做' }
    ]
  }),
  (mod) => ({
    title: '视图',
    items: [
      { keys: [mod, '1'], desc: '100%' },
      { keys: [mod, '2'], desc: '适配全部' },
      { keys: [mod, '3'], desc: '聚焦选中' },
      { keys: ['?'], desc: '打开 / 关闭本面板' }
    ]
  }),
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
    <Modal open={open} onCancel={onClose} footer={null} title="画布快捷键" width={600}>
      {GROUPS.map((g) => {
        const group = typeof g === 'function' ? g(MOD) : g
        return (
          <div key={group.title} style={{ marginBottom: 16 }}>
            <Typography.Text strong>{group.title}</Typography.Text>
            <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>
              {group.items.map((it) => (
                <div key={it.desc} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ minWidth: 200 }}>
                    {it.keys.map((k, i) => (
                      <span key={k}>
                        {i > 0 && <span style={{ margin: '0 4px', color: 'var(--ink-4)' }}>+</span>}
                        <Tag style={{ margin: 0, fontFamily: 'var(--font-mono)' }}>{k}</Tag>
                      </span>
                    ))}
                  </span>
                  <Typography.Text type="secondary">{it.desc}</Typography.Text>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </Modal>
  )
}
