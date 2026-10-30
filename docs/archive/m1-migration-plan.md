# M1 数据层迁移方案（v1 待审）

状态：待 Chief 审 + 用户确认。确认前不动数据层代码。

## ① 旧 History/Library → assets 字段映射

盘点结论（已核实源码）：
- History 权威数据源 = outputs 目录文件系统（`src/main/index.ts` 的 `history` handler 实时 readdir 生成列表）。每张图 = 图片文件 + 同名 `.json` 参数 sidecar；参考素材按内容哈希留档（`refsRead(hash, ext)`）。
  - 开发态路径：`D:\project\miaodraw\outputs`；打包态：`userData/outputs`
- 灵感库 = `resources/library`（随包只读）；风格库 = `library/styles.json`（随包只读）→ **不迁移**，画布内只读面板复用现有 IPC。

映射（每张历史图 → assets 一条）：
| assets 列 | 取值 |
|---|---|
| id | 新 UUID（终身稳定） |
| path | `outputs/<文件名>`（userData 相对路径） |
| status | `active` |
| size / mtime_ms | fs.stat |
| quick_hash / full_hash | 主进程算：hash(前4MB) / hash(全量)，sha256 或 xxh3（见待拍板） |
| width / height / mime_type | Electron nativeImage 读图头 + 扩展名 |
| name | 文件名 |
| metadata | sidecar JSON 原样（prompt/negative/w/h/seed/model/n/sequential） |
| migrationId | 本次迁移批次 id（回滚用） |

血统边（asset_dependencies）：sidecar 有 `refs[]` 的逐条建边——child=产物资产、parent=按 ref.hash 反查的素材资产（素材也在 outputs 留档，一并入库）、`role='reference'`、`operation='fusion'|'i2i'`；父查不到则边保留、parent 置 NULL（照 reference-pack 设计）。

## ② 原数据是否原地保留

是，一字节不动。只建索引，不搬不删：
- 图片展示走现有 `media://local/out/` 通道
- 旧 HistoryView 原样保留、直接读文件系统，与 assets 零耦合，迁移失败不影响任何现有功能
- 旧历史页删图（history:delete）→ 主进程广播事件 → 资产标 `status='missing'` → 30 天 GC（软删）

## ③ 防重复执行（三道保险）

1. IndexedDB meta store 记 `{migrationId, state: idle|running|done|failed, doneAt}`，state=done 直接跳过
2. assets 按 `path` 逐条查重，已存在即跳过（标记丢失重跑也安全）
3. 迁移完成后，画布页每次打开做轻量对账：扫 outputs 新增文件 → 补录资产（新作品常态入库，迁移是一次性、对账是常态机制）

## ④ 失败回滚

- 每条迁移资产带 `migrationId` 列，重跑前按它删上一批半成品，从头再来
- IndexedDB 事务 50 条一批提交，避免大事务卡死
- 原文件零改动 → 最坏情况 = 删索引行，无数据损坏可能
- 迁移在画布页首次打开时运行（非启动时），有进度提示、可中断

## 待拍板

哈希算法：
- A（推荐）：修 lockfile（重建 package-lock.json）后用 xxhash-wasm，性能最好
- B：node:crypto sha256，零新依赖，慢 3~5 倍但万张级完全够用

两者只影响哈希函数，表结构一致。
