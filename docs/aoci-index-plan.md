# AOCI 索引工作规程（miaodraw）

> 作用：说明本仓库的 AOCI-CODE 认知索引**怎么读、怎么维护**。
> 与 `AGENTS.md` 的关系：`AGENTS.md` 里的 AOCI 区块由 `aoci init` 生成并托管，**不要手改**（改了会被下次生成覆盖或冲突）；本文件是团队规程，`AGENTS.md` 只指向它。

## 一、开工前：先读索引，再读代码

任何 agent 开始任务前，先通过 AOCI 的 MCP 工具或 CLI 读认知层，而不是上来就翻文件：

1. `aoci_rules`（MCP）/ `aoci index header show`：读当前 Volume 的元规则与标签字典（本仓库为 zh-CN）。
2. `aoci_overview`（MCP）/ `aoci status --json`：读 Whole-Index 概览（哪些对象已索引、哪些是 observe/exclude）。
3. 需要具体对象时按需查条目：`aoci.code.txt` 是 Code Volume 正文，条目形如
   `file.ts[TAGS]: F:… | R:code:path/to/dep.ts | A:… | S:…`
   先读 F/R/A/S 再决定要不要打开源码，能把「一次任务翻 20 个文件」压到「先看 3 条条目 + 精读 1 个文件」。

**读索引不等于相信索引**：条目是上一轮作者化的结论，落地前仍以源码为准。

## 二、改完代码：在最终稳定态维护一次

- 代码改完、测试通过、**工作区稳定后**（不要再有未落盘的改动），调用一次 `aoci_maintain`（MCP，无参数）取得当前机器批次；按返回的 candidate/batch 用 `aoci_update_entry` 逐条更新。
- CLI 等价路径（本仓库未接 MCP 时）：`aoci index agent guide --agent <name> --json` → `aoci source manifest --json` 取源码指纹 → `aoci update-entry --path … --entry … --source-sha256 …`。
- 一次批次写成功后**立刻再调一次**，直到 remaining 为 0；中间不要问用户是否继续（批次不是用户决策）。
- 收尾必须跑：`aoci verify` → `aoci check`（Aggregate Check）→ `aoci index agent guide`，确认 `stage=aligned, complete=true, missing=0`。

## 三、条目由宿主 agent 读源码写

条目承载**语义**（职责 / 强关系 / 对外契约 / 非显然约束），只能由宿主 agent 读源码后写：

- **不得模板拼**：不要按文件名或目录批量套句式，也不要照抄示例条目的语义。
- F 写职责（≤160 字）；R 只写「改它时必须一起看的对象」；A 写对外契约；**S 只写 F/R/A 推不出来的、能防止踩坑的事实**，没有合格约束就写 `S:-`。
- 大文件读结构与关键分支即可，不必逐行；但**必须先读**才能下结论。

## 四、格式红线（踩过的坑）

| 项 | 规则 |
|---|---|
| E 档位 | 必须与真实行数匹配（T<100 / S100-200 / M200-400 / L>400）。**行数以 `aoci verify` 的 `file_lines` 为准**，不要用 `Get-Content \| Measure-Object -Line`（会少算空行） |
| 标签 | compact `A+B+C+[D]+E`；**code 域 B 轴没有 K**（K 只存在于 database 字典），内容类资产用 `B=B` |
| 条目首 token | 用文件 basename（如 `index.ts`），不要写 `orchestrator/index.ts` 这类半路径，否则报「对象身份不规范」 |
| A 字段 | 最多 **6** 项，超出报 `fras_a_too_many_items` |
| R 字段 | 最多 **8** 项；只接受精确托管身份 `code:path/to/file`（多项逗号分隔），无强关系写 `-` |
| S 字段 | 有 token 配额（按 UTF-8 字节 ÷3 计）：C6-C7 ≤80、C8 ≤140、C9 ≤200；超了先精简再提 |
| 写入方式 | Volumes v1 下 `index agent plan` 不可用（报 config 错），必须走 `update-entry`（与 MCP 同管线）；正式写入必须带 `--source-sha256`，哈希取自 `aoci source manifest --json` |

## 五、范围与边界

- 1525 个 `code_skipped`（二进制、空文件、超限文件）是**设计内排除**，不是缺陷；`check` 里出现它们是正常结果。
- 生成物与运行产物（`outputs/`、`videos/`、`node_modules/`、`out/`）不参与索引。
- 索引归属：`plan` 是真相源、画布节点只是视图——索引描述的是代码与文档，不描述运行期状态。
