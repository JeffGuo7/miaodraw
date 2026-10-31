# 画布交互模型（当前实现）

> 面向维护者：改动画布前先读这篇，避免把已经踩过的坑重新踩一遍。
> 参考实现：BeefTV（React + Go 的 AI 视频工作台）、basketikun/infinite-canvas（MIT，本项目引擎来源）。

## 1. 分层

```
CanvasWorkbench            组装层：工具条 / 右键菜单 / 快速新建 / 小地图 / 总键盘
├─ InfiniteCanvas          视口层：滚轮、平移、网格、指针路由（不认识节点）
│   └─ .ivc-world          世界层：一个 translate3d + scale，节点全部挂这里
│       ├─ ConnectionLayer 连线层：SVG，只覆盖当前可见世界矩形
│       ├─ SnapGuideLayer  吸附辅助线
│       └─ CanvasNode × N  节点：各自订阅自己的 store 切片
└─ ChatPanel / ShortcutsModal / MigrationOverlay
```

要点：

- **视口不是"再渲染一遍所有东西"的理由**。`CanvasWorkbench` 里节点列表用 `useMemo(..., [ids])` 缓存，
  视口变化只重渲染 `InfiniteCanvas` 与浮层；节点靠各自订阅（`useNode(id)`）更新。
- **热路径不 setState**：拖动连线只改 SVG 的 `d`（`pending-connection.ts`），框选只改 DOM 的
  `data-preview-selected` 和矩形 `style`，松手才提交一次选中集。

## 2. 滚轮与平移

`canvas-wheel.ts` 判定"这一下是缩放还是平移"：

| 条件 | 结果 |
| --- | --- |
| Ctrl / ⌘ + wheel（触控板捏合被浏览器转成这样） | 缩放 |
| Shift 或存在横向 delta | 平移 |
| 用户在视图设置里固定了 zoom / pan | 听用户的 |
| auto 且 200ms 内延续上一手势 | 沿用 |
| 行模式（deltaMode≠0）或整十步长 ≥40 | 滚轮 → 缩放 |
| 其余小步长 | 触控板 → 平移 |

缩放因子 `1.1^(-Δy/72)`（捏合 24），以光标为锚点；平移入口是空格 / 中键 / 抓手工具。
缩放范围 0.05–5（`viewport-fit.ts` 的 MIN_K/MAX_K，全项目唯一来源）。

```powershell
# 手感不对时用户在 UI 里改：右下角齿轮 → 滚轮 → 自动/缩放/平移
# 偏好存在 localStorage: miaodraw:canvas-prefs:v1
```

## 3. 网格

世界对齐 + **屏幕间距量化到 20–80px**：`spacing = 32 * k`，再乘除 2 直到落进区间。

- 纯随缩放：k=0.1 时变成 4.8px 的点阵，摩尔纹严重。
- 纯屏幕固定：失去"网格 = 世界尺度"的语义。
- 量化兼顾两者，且背景位移仍按 `viewport.x % spacing` 跟随平移。

三种背景（点阵 / 线条 / 空白）在视图设置里切换，`canvas-prefs.ts` 持久化。

## 4. 选中

- 点节点 = 单选并置顶；Shift / Ctrl / ⌘ 点击 = 增删选中。
- 拖空白 = 框选（Shift/Ctrl 为追加）；移动 < 4px 视为点空白 → 清空。
- 框选几何命中 **intersect**（与矩形相交即选中），不是 contain。

## 5. 连线

**只认端口圆，不认节点体**（`connection-hit.ts`）：

- 目标 = 节点左侧中部锚点，半径 44 屏幕像素（`44/k` 世界单位），从层级最高往下取第一个命中。
- 旧实现把节点包围盒也当目标（inside 档），拖到卡片身上就连上了，误连率极高。
- 无效目标会明确提示原因（`canConnect` 的 `reason`），不再"静默取消"。

**拖拽分流**（`CanvasNode.onPortPointerDown`）：

| 松手位置 | 行为 |
| --- | --- |
| 位移 ≤5px（只是点了一下端口） | 就地弹「新建并自动连线」菜单 |
| 命中合法目标 | 建连线 |
| 命中但类型不允许 | `message.warning` 说明原因 |
| 空白处 | 在落点弹新建菜单，建完自动连回源 |

## 6. 新建节点的落位

`placement.ts` 用"先向右找空列，再换行"的候选序列（4 列 × 12 行），保证：

1. 新卡不与已有卡重叠（旧实现 32px 步进在 320px 宽的卡片上等于完全重叠）；
2. 不会像"只向下堆"那样排成长柱跑出屏幕。

建完调用 `revealNode`：若新卡不完全在屏幕内，做最小位移把它带进视野（220ms 缓动）。

## 7. 键盘

守卫顺序（`CanvasWorkbench` 的总 keydown）：

1. 非输入框的 Delete/Backspace **无条件 preventDefault** —— Electron 里未消费的 Backspace 会触发
   历史后退，直接离开画布路由。
2. Esc 逐层退出：快速新建菜单 → 右键菜单 → 视图设置 → 清选择 → 关对话。
3. 输入框内只放行撤销/重做。
4. 有可见弹窗（`.ant-modal-wrap` 的 display 不为 none）时裸键让位。
   **不能只看 `.ant-modal-root` 是否存在**：AntD 关闭后仍保留 portal 容器，会把快捷键永久吃掉。
5. 之后才是各命令。

完整键位见应用内 `?` 面板（`ShortcutsModal.tsx`，按平台显示 ⌘/Ctrl）。

## 8. 浮层与层级

| 层 | z-index | 变量 |
| --- | --- | --- |
| 画布网格/世界层 | 0 | `--z-canvas` |
| 框选、吸附线、空态 | 5 | `--z-canvas-overlay` |
| 左上工具条 / 底部 Dock / 缩放 / 小地图 | 12 | `--z-canvas-dock` |
| 计划对话面板 | 15 | `--z-canvas-panel` |
| 右键菜单 / 快速新建 | 30 | `--z-canvas-menu` |
| 迁移遮罩 | 40 | 直接写死（唯一特例） |

浮层都必须带 `.ivc-no-zoom`，`InfiniteCanvas` 的滚轮/指针守卫会跳过它们；
另外它还会跳过 AntD 的 Portal 容器（`.ant-modal-root` / `.ant-popover` / `.ant-dropdown` /
`.ant-select-dropdown` / `.ant-picker-dropdown` / `.ant-tooltip`）—— 少了这一步，
在下拉里滚轮会缩放画布、按下会开始平移画布。

## 9. 视觉与动效

- 颜色/圆角/阴影/动效全部走 `styles/tokens.css`；画布 CSS 不再写死色值。
- 全站交互契约（`index.css` 末尾）：状态色 180ms、位移 120ms、按下 `scale(.975)`（纯图标 .92）、
  主按钮悬停上浮 1px、键盘聚焦 2px 品牌色 22% 环。
- 导航（适配全部/聚焦/100%）220ms ease-out，任何用户手势立刻打断。

## 10. 验收

```powershell
npm run test:canvas        # 含 connection-hit / placement / snapping / viewport-fit 等纯几何单测
npm run build
$env:TEST_MODE='screenshot'; $env:SHOT_CANVAS='1'; $env:SHOT_CANVAS_QUICK='1'
node_modules\.bin\electron.cmd .
```

画布相关探针：`SHOT_CANVAS` / `SHOT_CANVAS_CONNECT` / `SHOT_CANVAS_CONNECT_RULES` /
`SHOT_CANVAS_QUICK` / `SHOT_CANVAS_DRAG` / `SHOT_CANVAS_UNDO` / `SHOT_CANVAS_CLIP` /
`SHOT_CANVAS_MARQUEE` / `SHOT_CANVAS_HELP` / `SHOT_CANVAS_ASSETS`。

## 11. 文档持久化（关掉应用还在）

此前画布状态只活在渲染进程内存里，重开应用只剩计划卡——画了半天全丢。现在的链路：

```
任意变更 ──subscribeAny / subscribeGeometryChange──▶ 800ms 防抖 ▶ IndexedDB canvas_docs
页面隐藏 / beforeunload ─────────────────────────▶ 立即 flush
启动 ──hydrateCanvasDocument()（内存为空才执行）──▶ canvasStore.restore + setViewport
```

数据库：`db.ts` v6 新增 `canvas_docs`（单文档 `id='default'`）。**持久化顺序不能反**：
先水合画布文档，再回灌未完成的计划——反过来的话计划卡会让内存非空，水合会被直接跳过。

序列化规则（`canvas-doc.ts`，纯函数可单测）：

- 瞬态字段（`running/progress/status/failCount/pending/submitting`）一律剔除——重启后不该是"还在跑"。
- 节点/连线/视口逐条校验：坏行丢弃、尺寸夹到 80~4000、缩放夹到 0.05~5、悬空与自连的连线丢弃。
- **节点里不许有 base64**：上传图片走 `canvas:importImage` 落盘到 `userData/canvas-assets`，
  metadata 只存 `media://local/cvs/<file>`。历史遗留的超大 data URL 在序列化时丢弃内容并打
  `contentDropped` 标记（卡片和连线都还在，重新拖一次即可），保证文档永远是 KB~百 KB 级。
- 空画布 = 删除文档（不写空文档），所以「清空画布」不会被重启后的旧文档复活。

清空入口：左上工具条的红色删除按钮（二次确认，说明不可撤销）。

## 12. 上传与拖入

- 图片节点：点击或把文件拖到节点上 → `canvas:importImage` → 落盘 + 短路径。
- 画布空白：把图片拖进画布 → 在鼠标落点建图片节点（多文件按 28px 阶梯错开）。
  空画布引导里"直接把图片拖进来"的承诺到这一步才算兑现。
- 只接受图片；其它类型给一次 toast 说明，不静默吞掉。

## 13. 画布内的素材入口

- **本机作品抽屉**（左上「作品」）：列出 `outputs/` 最近 60 张，支持按提示词/文件名搜索，
  点一张就在视口中心落一个图片节点（内容存 `media://local/out/<file>`）。
  之前要复用上一张图必须离开画布去「历史记录」页再绕回来，画布作为装配台是断链的。
- **图片节点按真实比例自适应一次**：图片首次载入时按 naturalWidth/Height 调一次节点高度
  （夹到 120~1200），之后尊重用户手动尺寸（`metadata.autoSized`）。
  不调的话 320×320 方卡里放竖图会留出大片空白，画布显得脏。

## 14. 已知取舍（下一轮可做）

- 画布文档是**单文档**（`id='default'`）。多画布/项目化管理需要把 doc id 换成项目 id，
  `canvas_docs` 表结构已经按这个方向设计（keyPath 是 id）。
- 节点数量到 200+ 时再加视口剔除与 LOD；现在几十个节点不值得引入这层复杂度。
- 生成失败的「重试 / 只看失败项」仍是单节点按钮级，批量失败聚合留待生成批次真做多图时再补。
