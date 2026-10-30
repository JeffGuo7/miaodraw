# 画布交互手感优化清单（v1 草稿）

触发：用户实测反馈「工作流拖拽不够丝滑」。
作者：Rea。状态：**待 Jeff 审**，审完转 Coder。

## 0. 结论先行（按可能性排序的三条根因）

| # | 根因 | 证据 | 影响 |
|---|---|---|---|
| 1 | **拖动过程不更新画面**：`moveNodeSilent()` 静默改 state 不发通知，整条拖动路径上唯一一次 `commit()` 在 `pointerup` | `store.ts` L69-80 JSDoc「由调用方节流提交」；`CanvasNode.tsx` L68-83 拖动 move 里只调 `moveNodeSilent`，up 里才 `commit()` | 视觉上应表现为跟手延迟/松手跳变（**代码推断，需 Coder 实测复核**） |
| 2 | **节点用 `left/top` 定位**：每帧改的是布局属性，不是合成属性 | 我方 `CanvasNode.tsx` L111 `style={{left,top,...}}`；上游同款节点用 `transform: translate()` + `contain: layout style`（`infinite-canvas/web/src/components/canvas/canvas-node.tsx` L298-308） | 每帧强制 layout，节点多时掉帧 |
| 3 | **连线全程无反馈**：落点判定靠 `elementFromPoint`，拖动时每帧 `document.querySelector` + `getBoundingClientRect`，且目标无高亮、无吸附 | `CanvasNode.tsx` L39-58（连线）、L142-147（每次 move 两次 DOM 查询）；上游用世界坐标几何判定 + 端点吸附（`project.tsx` L655-689、`canvas-connections.tsx` L62-77） | 连线"拖得动但不知道会不会连上"，命中率低 |

## 1. 取证说明（区分"证据"与"最佳实践"）

- **我方现状**：逐行读过 `src/renderer/src/canvas/{InfiniteCanvas,CanvasNode,CanvasWorkbench,store,canvas.css}`，行号已标注。
- **上游对照**：`D:\project\infinite-canvas\web\src\`（MIT，同源）。移植时砍掉了不少交互设计，这是本清单的主要依据来源。
- **MiniMax 实测**：从其画布 bundle `CanvasPage-MuABU4gC.js` 提取的字面量证据（下表）。注意：MiniMax 的 md 材料（`D:\project\minimax-skills\`）**没有 UI 手感规范**——只有语义契约（建节点去重、完成证明、分组行为）；手感证据只在 bundle 里。
- **通用最佳实践**：标注为「通用」，非取自本项目。

MiniMax bundle 字面量统计（`CanvasPage-MuABU4gC.js`，静态字符串计数）：

| 痕迹 | 次数 | 说明 |
|---|---|---|
| `setPointerCapture` | 14 | 指针捕获，拖拽不丢事件 |
| `translate3d` | 14 | GPU 合成层位移（不是 left/top） |
| `requestAnimationFrame` | 84 | 每帧提交 |
| `ResizeObserver` / `IntersectionObserver` | 44 / 10 | 尺寸与可见性观察（视口裁剪） |
| `passive` | 44 | 避免滚动阻塞 |
| `will-change` / `contain:` | 2 / 2 | 渲染隔离提示 |
| `elementFromPoint` / `getBoundingClientRect` | 6 / 196 | 命中测试（少量 DOM 命中 + 大量几何计算） |
| **d3-zoom 内部符号**（`zoomPanValues`/`noWheelClassName`/`scaleBy`/`constrain`/`deltaMode===1?.05:1:.002`/`scaleTo`） | — | 视口行为直接用 **d3-zoom**，不是手写 wheel |
| **React Flow 内部符号**（`nodeLookup`/`snapGrid`/`snapToGrid`/`nodeDragSnapResolver`/`nodeExtent`/`dragItems`） | — | 节点图用 **@xyflow/react**，自带网格吸附与边界约束 |

→ 结论：MiniMax 的手感靠**成熟行为库 + 指针捕获 + GPU 位移 + 每帧提交 + 观察者裁剪**；我们和上游都是手写，那就该把上游砍掉的那部分补回来。

## 2. 优化清单

### P0-1 拖动跟手（修复根因 1）

- **现状问题**：`CanvasNode.tsx` L68-83：`pointermove` → `canvasStore.moveNodeSilent()`（不 emit），`pointerup` → `commit()`。React 不重渲染，节点视觉位置在松手前不变。
- **依据**：上游同名逻辑在 `project.tsx` L1362-1392 是**每帧 rAF 提交**：`requestAnimationFrame(() => { setNodes(...); setDropTargetGroupId(...) })`，且用 `initialSelectedNodes` 从初始位置算增量（不会累积漂移）。
- **改法**（DOM 栈）：拖动开始记录 `originPositions`；`pointermove` 里 rAF 合并，帧内调用一次 `canvasStore.setNodesMoved(ids, dx, dy)`（新增方法，按初始位置 + 增量写入并 emit）；`pointerup` 停帧、单次 commit 收尾。若想更极致：拖动期间直接给被拖节点写 `style.transform`（绕过 React），松手时再提交 state。
- **预期收益 / 成本**：跟手延迟从"整段拖动不可见"降到 ≤1 帧。**成本 S**。
- **优先级：P0（最高）**

### P0-2 定位属性 left/top → transform（修复根因 2）

- **现状问题**：`CanvasNode.tsx` L111 用 `left/top`；`canvas.css` L26-35 无 `contain`，且节点内是 AntD 组件（Select/Button/Progress）——布局成本高。
- **依据**：上游 `canvas-node.tsx` L302-308：`transform: translate(x,y)` + `contain: layout style` + `transition: box-shadow 200ms`（**只过渡阴影**，不碰几何，避免"拖影"）。MiniMax 侧 `translate3d` ×14、`contain:` ×2 同向。
- **改法**：节点样式改 `transform: translate3d(${x}px, ${y}px, 0)`；加 `contain: layout style`；`transition` 只保留 box-shadow；选中态不要 transition 尺寸/位移。
- **收益 / 成本**：位移走合成层，200 节点量级更稳。**成本 S**。
- **优先级：P0**

### P0-3 拖动路径上的 DOM 查询（性能）

- **现状问题**：`CanvasNode.tsx` L42-44 每次 `pointermove` 都 `document.querySelector('.ivc-root')` + `getBoundingClientRect()`（读布局 → 强制同步 layout）；L142-147 同样。
- **依据**：通用实践；上游把容器 rect 放 `size`/`containerRef`（`project.tsx` L693-695）而不是每帧查询。
- **改法**：容器 rect 缓存进 store 或 context（`ResizeObserver` 更新，MiniMax 用了 44 处 ResizeObserver），拖动只做算术。
- **收益 / 成本**：去掉每帧同步布局，抖动明显减少。**成本 S**。
- **优先级：P0**

### P0-4 连线过程中的实时反馈（修复根因 3 的前半）

- **现状问题**：
  1. `CanvasNode.tsx` L45 `setPendingFrom({...})` —— 每次 `pointermove` 触发 React 重渲染整张节点卡（含 AntD 控件）。
  2. L137 `PendingLine` 渲染在**节点元素内部**，但坐标是 `worldOrigin()` = `{0,0}` 到鼠标世界坐标（L148-150）；节点自身有 `left/top` 偏移，所以这条线整体被节点位置平移——**起点不是端口**，视觉错位。
- **依据**：上游把连线画在**画布级 SVG 层**（`canvas-connections.tsx`），并在 `project.tsx` L1394-1399 只更新 `mouseWorld` / `connectionTargetNodeId` 两个轻量状态。
- **改法**：把 pending 线移到 `CanvasWorkbench` 的 `ConnectionLayer` 同级层（世界坐标层，绝对定位），起点用源节点端口锚点；鼠标位置与目标高亮用 ref + rAF 驱动 SVG path 的 `d` 属性（甚至直接改 DOM 属性），不走整卡重渲染。
- **收益 / 成本**：连线时不再掉帧、起点正确。**成本 M**。
- **优先级：P0**

### P0-5 连线落点判定与吸附（修复根因 3 的后半）

- **现状问题**：`CanvasNode.tsx` L51 `document.elementFromPoint()` + `closest('[data-node-id]')`：无 padding、无优先级、缩放后端口更难点、拖到空白处静默失败、拖回自己不算。
- **依据**：上游 `getConnectionDropTarget`（`project.tsx` L655-689）**纯几何判定**：世界坐标 → 与节点包围盒比较（内 / 扩边 / 端口半径三档），`padding` 与 `handleRadius` 都除以 `scale` → **屏幕像素命中面积恒定**；优先级 `inside(0) > handle(1) > expanded(2)`；并且 `ActiveConnectionPath`（`canvas-connections.tsx` L62-77）在悬停时把端点**吸附**到目标的锚点（`snappedStartX/Y`），支持反向连线（target 侧拖起）。
- **改法**：抽 `lib/canvas/connection-hit.ts`：`hitTestConnectionTarget(nodes, world, handle, viewport.k)` 返回 `{nodeId, isNear, priority}`；拖动中用 rAF 更新 `hoverTargetId`，目标节点加 `ivc-node-drop` 高亮类；端点线吸附到目标锚点；空白释放 = 取消（并给一次轻提示，不弹 toast 打断）。
- **收益 / 成本**：缩放到 25% 也能连上；有吸附"磁性"手感。**成本 M**。
- **优先级：P0**

### P1-6 命中区域（统一按屏幕像素补偿）

- **现状问题**：端口 `canvas.css` L146-158 固定 14px、resize 手柄 14px（L134-143）、连接线整层 `pointerEvents:'none'`（`CanvasWorkbench.tsx` L321）——线不可点、不可删。
- **依据**：上游连接线用**16px 透明描边**做点击热区 + 2-3px 可见线 + 选中态发光（`canvas-connections.tsx` L31-49）；端口在 `canvas-node.tsx` L984 `ConnectionHandleDot`（左/右手柄，hover/selected 才显形）。
- **改法**：端口/手柄的**视觉尺寸不变**，但热区用 `::after` 或包裹层做到屏幕恒定 24px（缩放时 `transform: scale(1/k)` 反向补偿）；连接线加透明粗描边 + `pointerEvents:'stroke'`，支持点选与右键删除。
- **收益 / 成本**：小缩放下的误点/点不中明显改善。**成本 S-M**。
- **优先级：P1**

### P1-7 吸附与对齐

- **现状问题**：无网格吸附、无对齐参考线、无分组吸附；`store.ts` L94-98 `addConnection` 也无重边校验（上游 `project.tsx` L621 有 `exists` 检查）。
- **依据**：MiniMax 用 React Flow 的 `snapGrid` / `snapToGrid` / `nodeDragSnapResolver` / `nodeExtent`（bundle 字面量）；上游有**拖入分组吸附** `snapNodesIntoGroup`（`canvas-node-geometry.ts` L34-49，pad=24，含"放不下就整体推入"的 dx/dy 计算）与 drop 目标高亮（`project.tsx` L1382）。
- **改法**：拖动时吸附到 8px（可配置 24px）网格，按住 Alt 临时关闭；同列/同行吸附线（与最近 3 个节点的左/中/右、上/中/下对齐，阈值 6 屏幕像素）；拖入分组容器时高亮并在松手时吸附归组（直接复用上游 pad 算法思路）。
- **收益 / 成本**：排版整齐、减少微调。**成本 M**。
- **优先级：P1**

### P1-8 光标状态机与取消

- **现状问题**：光标只有 `grab/grabbing/crosshair`（`InfiniteCanvas.tsx` L190、`canvas.css` L54/L156）；节点拖动只监听 `pointerup`（`CanvasNode.tsx` L75-82），**没有 `pointercancel`**，窗口失焦/系统手势会留下悬挂拖动；连线无 Esc 取消。
- **依据**：上游把 `pointercancel` 与 `pointerup` 同等处理（`infinite-canvas.tsx` L183）；MiniMax `setPointerCapture` ×14（捕获后事件不丢）＋ `passive` ×44。
- **改法**：拖动/连线期间 `setPointerCapture`；统一监听 `pointerup` + `pointercancel` + `blur` + `keydown:Esc`；光标分级：`grab→grabbing`、连线中 `crosshair`、悬停可连目标 `copy/alias`、非法 `not-allowed`。
- **收益 / 成本**：不再出现"松手前突然断连"的怪异状态。**成本 S**。
- **优先级：P1**

### P1-9 拖拽取消与回滚（undo）

- **现状问题**：拖动无快照，误拖只能手动拖回；`store.ts` 无历史栈。
- **依据**：上游在拖动期间 `historyPausedRef.current = true`（`project.tsx` L1301、L1321）——整段拖动只入一条历史；MiniMax 材料 `contracts/canvas-discipline.md` L14 也强调文本编辑要带 `expectedContentHash`（防覆盖），说明他们对"可恢复"有硬要求。
- **改法**：拖动开始记 `{id, x, y}` 快照；Esc 还原快照；正常结束把整段拖动作为**一条**历史入栈（`pushHistory`），历史里合并高频位移。
- **收益 / 成本**：可纠错，手感"敢拖"。**成本 M**。
- **优先级：P1**

### P1-10 视口变化时的重渲染范围

- **现状问题**：`CanvasWorkbench.tsx` L167-169 遍历全部节点并把 `scale` 传下去——缩放时每个 `CanvasNode` 都重渲染（节点内含 AntD 组件）；MiniMap 在 render 里 `document.querySelector` + `getBoundingClientRect`（L262-269），随每次视口变化执行。
- **依据**：上游 `visibleNodes` 视口裁剪（`project.tsx` L702-705，padding 280）+ 连接线裁剪（L709 注释：用控制点包围盒判断）；MiniMax 用 `IntersectionObserver` ×10 / `ResizeObserver` ×44。
- **改法**：① `CanvasNode` 用 `React.memo`，并**移除 `scale` prop**（拖动时从 `canvasStore.getState().viewport.k` 现取，或经 CSS 变量下发），让缩放不触发节点重渲染；② 视口裁剪可见节点（同上游 padding 思路）；③ MiniMap 的 rect 用 `useRef` 缓存 + `ResizeObserver`，并把节点包围盒计算 `useMemo`。
- **收益 / 成本**：缩放/平移帧率显著提升，大画布可用。**成本 M**。
- **优先级：P1**

### P1-11 滚轮缩放归一化与平滑

- **现状问题**：`InfiniteCanvas.tsx` L102-104 `factor = 1.1^(deltaY/100)`——不区分 `deltaMode`（行模式/像素模式）、不处理 `ctrl+wheel`（触控板捏合：浏览器会把它当 ctrl+wheel，`deltaY` 极小，导致缩放迟钝）、无过渡动画。
- **依据**：MiniMax 的 d3-zoom 归一化（bundle 原文）：`-deltaY * (deltaMode===1 ? 0.05 : deltaMode ? 1 : 0.002) * (ctrlKey ? 10 : 1)`，并配 `transition().duration().ease()` 做平滑。
- **改法**：按上式计算指数因子（触控板/鼠标统一手感的行业做法）；捏合（ctrl）走连续小步长；可选：松手后 120-180ms 缓动向目标缩放收尾。
- **收益 / 成本**：滚轮/触控板一致、不"木"。**成本 S-M**。
- **优先级：P1**

### P2-12 分组交互（拖入归组）

- **现状问题**：`group` 节点只显示占位文案（`CanvasNode.tsx` L195「拖入内容自动归组（后续）」）——功能未接。
- **依据**：MiniMax `contracts/canvas-grouping.md`：分组由 gateway **原子应用网格布局**（L13「applies grid layout atomically」）、取消分组**恢复子节点绝对位置**（L25）、位置信息不全时要**请用户先交互一次**而不是猜（L26）；上游 `findGroupDropTarget` + `snapNodesIntoGroup`（pad 24）。
- **改法**：拖动时检测落点是否在 group 内（中心点包含判定，上游 `containsCenter`），高亮目标 group，松手吸附归组并把组内节点按网格重排；取消分组恢复绝对坐标。
- **收益 / 成本**：整理大量卡片的主要手段。**成本 M**。
- **优先级：P2**

### P2-13 hover 工具栏与快捷操作

- **现状问题**：只在选中时显示一个删除按钮（`CanvasNode.tsx` L117-126）。
- **依据**：上游有独立 `canvas-node-hover-toolbar.tsx`（18KB），hover/选中即出常用操作。
- **改法**：hover 出现轻量工具条（生成/下载/复制/删除/更多），`transition-opacity` 200ms，禁止 `transition: all`。
- **收益 / 成本**：减少鼠标移动距离。**成本 M**。
- **优先级：P2**

### P2-14 多选与框选

- **现状问题**：`store.ts` 的 `selectedIds` 是数组但 `select()` 只写单值（L82-84），无框选、无 shift 多选、无多节点拖动。
- **依据**：上游 `selectNodeByEvent` 支持 shift/meta/ctrl 增删选，`dragRef.initialSelectedNodes` 是 Map（多节点一起拖），组拖动会带上子节点（`project.tsx` L1283-1302）。
- **改法**：空白拖动 = 框选矩形（世界坐标），shift 点选增删，多选拖动沿用 P0-1 的 origin 快照机制。
- **收益 / 成本**：批量操作必需。**成本 M-L**。
- **优先级：P2**

### P2-15 平移惯性 / 缩放到点位

- **现状问题**：平移无惯性；无双击缩放、无"聚焦到节点"。
- **依据**：MiniMax bundle 有 `velocity` ×25 但**未见 friction/momentum/deceleration**（无证据不下结论，标注为不确定）；上游有完整 `focusViewportForNode`（`canvas-node-geometry.ts` L164-176：按节点+上下浮层算可用区域、3:1 分空间、缩放上限 0.05-1）。
- **改法**：惯性列为可选（先做 120ms 缓动吸尾，视用户反馈再定）；「聚焦节点」直接照上游算法实现（选中/双击节点时平滑移动视口）。
- **收益 / 成本**：导航更省力。**成本 S-M**。
- **优先级：P2**

## 3. 建议实施顺序与验收

**第一波（手感救命，约 1-2 天）**：P0-1 拖动提交 → P0-2 transform → P0-3 缓存 rect → P0-5 几何命中+吸附 → P0-4 pending 线独立层。
**第二波（约 2-3 天）**：P1-6 命中区域 → P1-8 光标/取消 → P1-9 回滚 → P1-7 吸附对齐。
**第三波**：P1-10 渲染范围 → P1-11 滚轮归一化 → P2 分批。

**验收指标（可自动化，接 `SHOT_PLAN` 钩子）**：
1. 拖动跟手：**每帧至少一次位置提交**（可在 rAF 里打点断言），松手无跳变（前后位置差 < 2px）
2. 连线命中：在 k=0.25 / 1 / 2 三档缩放下，对 24px 外的目标边缘也能命中（几何函数可直接单测，不需要截图）
3. 性能：200 节点画布，拖动与缩放期间无 >50ms 长任务（Performance 面板或 `performance.now()` 打点）
4. 取消：Esc 中断拖动后坐标回到快照值；一次拖动 = 一条历史记录

## 4. 风险与不做的事

- **不要引入画布库**（Konva/fabric/pixi/React Flow/d3-zoom）：DOM 路线是既定选择，加库要重写节点体系；MiniMax 用 d3-zoom 只说明"视口行为值得用成熟实现"，我们可以照公式自写（P1-11），几十行。
- **拖动期间直接改 DOM 要小心**：松手后必须让 React state 与视觉一致，否则回弹；推荐先做"rAF + store emit"（简单可靠），个性化性能问题再上 DOM 直改。
- **pending 线移层要注意层级**：新层必须 `pointerEvents:'none'`，否则会挡住 P0-5 的命中判定（这也正是现在 `elementFromPoint` 方案的隐患之一）。
- **本清单中标注"代码推断"的第 1 条根因请先实测确认**：如果实测拖动其实跟手（例如期间还有别的 emit 路径），那么 P0-1 降级、P0-2/P0-5 升为第一优先。
