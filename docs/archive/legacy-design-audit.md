# 存量设计体检：拿逆向资料照镜子

作者：Rea。状态：待 Jeff 审（先不提交）。范围：**存量功能面**（不含手感清单、不含编排设计，二者已单独交付）。
证据约定：`我方` = 行号可直接核对；`MiniMax` = `D:\project\minimax-skills\` 明文 md 或 bundle 字面量；**未找到** = 检索过无证据，不推测。

## 主表

| # | 功能面 | 现状（文件+关键行） | 逆向/上游对应设计（出处） | 差距 | 优化建议 | 成本/收益 | 优先级 |
|---|---|---|---|---|---|---|---|
| 1 | 创作页（出图/融合/组图/复现） | `views/CreateView.tsx` L76-81 融合模板（靠"图1/图2"位置引用）；L220-226 `refLimit` 按模型给素材上限；L281 wan2.7 `enable_sequential` 组图；L182-190 seed 复现 | `semantic-judgment.md` L21-33 输入角色表（source/layout/style/character/mood）+ 五值决策 take/adapt/ignore/block/ask；L39-47 参考图分析须产出角色事实、prompt 须点名具体可见特征；`character-refs.md` L19 厂商参考图上限 | 融合只做**位置引用**，无角色绑定、无"保留/忽略"决策、无可解释层 | 模板升级为角色槽（主体/风格/构图/场景），提示词预览显示"每张图贡献了什么" | M / 高 | P1 |
| 2 | 合成画布（旧 Konva 栈） | `views/ComposeView.tsx` L58-68 视口 clamp；L407-435 导出 PNG 走内存送创作页；L444 `exportPng` | `_shared/video-merge.md` L12 后处理只做确定性操作；L30 **返回 path 不算交付**，须写回画布节点；`canvas-discipline.md` L12-16 完成证明 | 合成结果**不落作品目录、不进资产索引**，无血统边、无版本、不可追溯 | 导出落 outputs + assets 行 + 血统边（parent=各图层，operation='compose'），复用 M1 资产层 | S-M / 中高 | P1 |
| 3 | 灵感库（提示词案例） | `views/LibraryView.tsx` L30 PAGE_SIZE 60、分类/收藏/详情；`StyleLibrary.tsx` L16 内置 336 条（手绘245/商业22/实战69） | `knowledge/image-recipes/` 按**品类配方**组织；`media-agent.md` L81 命中配方即读一张卡、直接编译 prompt；`ad-tvc/reference/visual-techniques/T01-T20` 编号技法卡 | 我们只有"案例/条目库"，缺**结构化配方层**与"命中即编译"机制 | 提炼 8-12 张品类配方卡（参数化复用 `prompt-guards.buildImagePrompt`），案例卡加"用此配方复现" | M / 中高 | P2 |
| 4 | 提示词反推 | `views/DistillView.tsx` L71 `distillLocal`（本地模型+可选改写）；L205 送创作页 | `semantic-judgment.md` L79 `purpose:"prompt-reconstruction"`：**仅用户明确要求可复现 prompt 时启用**；保留画面/文字/logo/版式/颜色；用 `metadata.exact_aspect_ratio` 与独立文字读取（含不确定标注）；默认不生成媒体 | 缺"重建模式 vs 描述模式"区分；缺不确定项标注（读不清不猜）；缺精确画幅 | 结果分两栏：描述 / 重建 prompt（带不确定标注+画幅）；重建模式显式按钮触发 | S / 中高 | P1 |
| 5 | 历史记录 + outputs + sidecar | `src/main/index.ts` L1077「sidecar 只记 hash，复现不依赖原文件」；L1213 删除含 sidecar；L1263 `archiveRefs`；`HistoryView.tsx` props 含 onReproduce | `0001_init.sql` L31-67 assets（status active/missing、quick/full hash、candidate 合并列）；L54-66 缺失行内合并；`stage-execution-plan.md` L42 `superseded_runtime_refs`；`media-agent.md` L87 `new_round`（旧版本保留可切换） | 已有 hash+sidecar+复现（**强于多数同类**）；缺①缺失文件候选合并 UI（M1 已留 `candidate_asset_id/path`，`db.ts` L25-26 有列无 UI）；②同参数重生成的"轮次"概念 | 历史卡加候选合并入口；同 prompt/seed 结果聚合成版本轮次 | M / 中 | P2 |
| 6 | 设置（多厂商/密钥/目录） | `src/main/index.ts` L133-138 密钥密文；L169-180 `safeStorage` + `plainFallback`；L209-221 masked/plan | `media-agent.md` L15 全局出图数上限 `max_total_images`（成本闸门）；`plugins/session-header.ts` L150-177 计费 scope fail-closed。**未找到**其本地密钥存储实现 | 我们有 safeStorage + 降级提示（**强项**）；缺成本/额度闸门与用量统计 | 加"本次任务最大出图数"上限 + 本地用量累加 | S / 中 | P1 |
| 7 | 内置风格库 336 条 | `StyleLibrary.tsx` L16、L51 `pick` 填入创作页 | `knowledge/vendors/` 15 张模型卡（同意图在不同模型写法不同，如 `seedance.md` 事件节拍）；`poster.md` 品类配方 | 条目缺元数据（适用模型族/是否含文字/是否需参考图），无法按模型适配 | 每条补 2-3 个元数据，生成前按 activeModel 过滤或提示 | S-M / 中 | P2 |
| 8 | 自研更新器 | `src/main/updater.ts` L135-190 下载；L146 **仅按 size** 判断复用；L179 rename；L193-197 `shell.openPath`；grep `sha256/signature/verify` **无命中** | MiniMax 打包启动 `app/out/main/index.js`（深挖笔记-02 引用）：更新资产须同源 HTTPS + 固定路径 `velopack/<channel>/builds/<ver>/<stamp>`，且**预校验 sha256+size**（L57-92） | **无任何完整性校验**；size 相同即复用（内容不同会误用） | release 元数据加 sha256，下载后校验（失败删除并报错）；复用条件改 size+sha256；feed 限同源 HTTPS | S / 高 | **P0**（方案见下节「P0 修复方案」） |
| 9 | agent.ts + tools.ts 闭环 | `agent.ts` L129-154 单轮规划→顺序执行；L166-231 失败卡审计/保真/编造防护/上限截断；`tools.ts` L44-91 规划提示词含失败卡+厂商上限；L98-129 服务端校验（白名单/必填/最多8步） | `planner.md` 一次一 stage/稳定 id/禁 placeholder；`stage-execution-plan.md` L37 work item 须含可派发成品 prompt；`media-agent.md` L184 同 stage 最多重试 2 次（gpt-image 3 次）、L114-121 审查闸门、`canvas-discipline.md` L15 完成证明 | 无持久计划/revision/审查闸门/重试上限/完成证明校验（由 O1~O4 承接，此处不重复设计） | 按 `docs/orchestration-design.md` 推进 | — | 交 O1~O4 |

## P0 修复方案：更新器完整性校验（含发布侧核实）

### 发布侧现状（已实测，不是推测）

- **`dist/latest.yml` 已经带 hash**：`dist/latest.yml` L4-5 `sha512: xGwGqJlQ…`、`size: 261780675`（electron-builder 生成），同目录另有 `miaodraw-setup-0.1.0.exe.blockmap`（272KB）
- 即**发布产物已有校验数据**，客户端只是没读
- GitHub Releases 目前**还没有 Release**（`api.github.com/repos/JeffGuo7/miaodraw/releases/latest` → 404），所以 GitHub 分支暂无实数据；其 asset 是否带 `digest`（sha256）**未验证**，不作为唯一依赖
- 自定义 feed 当前契约只有 `{version, url, notes}`（`src/main/updater.ts` L79），**没有 hash 字段**

### 客户端改法（fail-closed）

1. **数据来源**（改 `checkUpdate`）
   - 自定义 feed：契约扩为 `{version, url, sha512 | sha256, size, notes}`；推荐 feed 直接复用 `latest.yml` 内容，客户端解析 `files[0].sha512/size`（零新增产物）
   - GitHub 分支：先只读 `size`（现状），若拿到 digest 再启用；拿不到 hash 时**不静默放行**
2. **校验时机**（改 `downloadUpdate` `updater.ts` L135-190）
   - 边下边算：`createHash('sha512')`（`node:crypto`，零新依赖）流式喂入，同时累计字节数
   - 完成后先比对 `size` 再比对 `hash`，**全部通过才 `rename`**（现在 L179 是先 rename 后可用 → 改为「校验通过 → rename」，失败则删除 `.part` 并返回错误）
3. **缓存复用**（改 L146）
   - 现在：`existsSync && size 相同` → 直接复用；改为「`size` + `hash` 都相同」，且复用前**重算一次 hash**（防磁盘文件被替换）
4. **安装前二次校验**（改 `installUpdate` L193-197）
   - `shell.openPath` 之前再校验一次 hash；不通过则拒绝启动并提示重新下载
5. **传输约束（建议同步做）**
   - 下载 URL 强制 HTTPS；下载来源与 feed 同源（照 MiniMax `app/out/main/index.js` L57-92 的 immutable feed 思路，避免镜像串包）

### 要不要改发布流程？——取决于 feed 形态

| 方案 | 发布侧改动 | 说明 |
|---|---|---|
| A（推荐） | **零改动** | feed 直接指向/复用 `latest.yml`（已含 sha512+size），客户端解析即可 |
| B | 需改发布脚本 | 若 feed 是手工维护的 JSON，需补 `sha512` + `size` 两个字段（值可从 `latest.yml` 抄） |

另：Release 上传时把 `latest.yml` 一并上传（electron-builder 默认产物），客户端才能取到 hash。

## 我们更强的三处（别只挑毛病）

1. **提示词质量层已落代码**：`prompt-guards.ts` L23 失败卡、L91 厂商卡、L130 海报配方（原句+增强尾句+色彩比例 60-70/20-30/5-10）、L222 编造检测、L232 用户原句保真。MiniMax 同类内容仍是**给 agent 的规范文本**，未固化为本地校验。
2. **sidecar + hash 复现链路**：`index.ts` L1077 明确"复现不依赖原文件是否还在"，比"靠文件名猜"稳。
3. **密钥安全**：`safeStorage` 加密 + `plainFallback` 显式标记（`index.ts` L169-180），MiniMax 侧未找到可比实现。

## 建议先做 Top 5

1. **更新器 sha256 校验**（P0，安全，S）——当前是明确风险
2. **合成画布产物入资产链**（P1，S-M）——低垂果实，直接复用 M1
3. **反推"重建模式"规范化**（P1，S）——不确定标注 + 精确画幅
4. **创作页输入角色 + 五值决策轻量版**（P1，M）——多素材融合质量与可解释性
5. **出图数量上限与用量统计**（P1，S）——成本闸门

## 明确不值得做

- **不引入多 agent/MCP 网关架构**：MiniMax 是五 agent + 网关规模，我们单进程编排足够（见编排设计 §10）。
- **不照搬 Production Board 全字段**：其 `work_items` 校验器面向 executor，属 O4 范围，现在抄会让 O1 过重。
- **不做计划变更历史双向同步**：`plan_events` 单向 append 即可（MiniMax 未找到此项，属其短板）。
- **不把 ComposeView 迁到 DOM 画布**：Konva 层合成是确定性后处理，与无限画布职责不同；MiniMax 也把确定性后处理单独分层（video-merge.md L12）。
- **不引入 d3-zoom / React Flow**：视口与几何命中手写即可（见手感清单 §4）。
