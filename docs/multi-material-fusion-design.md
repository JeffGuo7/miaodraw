# 多素材融合（Multi-Material Fusion）设计方案

> 日期：2026-10-03 ｜ 目标：把现在"单张参考图 + 提示词"的图生图，升级为**多素材融合**：用户丢进 N 张素材（主体/风格/背景/姿势/线稿…），配一句指令，产出一张融合图
> 能力依据：百炼官方文档（详见 §1），两个引擎的多图上限不同，必须**按模型能力驱动 UI**

---

## 1. 官方能力边界（已核对 raw 文档）

| 引擎 | 协议 | 多图上限 | 关键参数 |
|---|---|---|---|
| **wan2.7-image / -pro** | DashScope 原生 **同步** `POST /api/v1/services/aigc/multimodal-generation/generation` | **0–9 张** | `input.messages[0].content = [{image}, {image}, {text}]`；`parameters.{size,n,watermark,seed,bbox_list,enable_sequential}` |
| **qwen-image-3.0 / -pro** | OpenAI 兼容 **同步** `POST /compatible-mode/v1/images/generations` | **1–3 张** | 参数**平铺**：`image`（string 或 **string[]**，顺序即图1/图2/图3）、`size:"1024x1024"`（字母 x）、`negative_prompt`、`seed`、`prompt_extend`、`prompt_extend_mode`、`enable_thinking`、`watermark`；`n` 可 1–6 |
| 其它 OpenAI 兼容（硅基流动/GPT-Image/自定义） | `/images/generations` | 目前 0–1（仅 T2I） | 已有 `httpGenerate` |

> 官方 wan2.7 示例即"融合"语义：`content: [{image: 车}, {image: 涂鸦}, {text: "把图2的涂鸦喷绘在图1的汽车上"}]`
> qwen-image-3.0 不支持 `/images/edits` multipart、不支持 mask、不支持流式；I2I 场景 `prompt_extend_mode` 只能是 `direct`。

**结论**：多素材融合不需要本地模型，**今天的 API 就能做**，且两个引擎都是同步返回，与现有 HTTP 层同构。

---

## 2. 产品设计：三种融合方式

| 方式 | 一句话 | 适用 | 实现 |
|---|---|---|---|
| **A. 智能融合** | 素材全丢给模型，用自然语言指令融合（"把图2的涂鸦喷到图1的车上，保持图3的光线"） | 90% 场景，最快 | 单次多图请求（wan2.7 ≤9 / qwen-image ≤3） |
| **B. 精修合成** | 先在「合成」画布摆好版式（图层/蒙版/文字），导出预合成图 → 再交给模型"统一风格/精修" | 海报、电商主图、版式确定 | 合成页「送到创作页」→ 单图 I2I |
| **C. 分步编辑** | 抠图去背 → 合成 → 局部重绘/擦除，逐环节可控 | 需要精确贴合、逐处修改 | 本地 rembg/BiRefNet + 百炼 bbox 局部编辑 / IOPaint（后续批次） |

UI 上做成创作页的「融合方式」三选一（默认 A，B 引导去合成页，C 标注"进阶"）。

---

## 3. 交互设计（创作页）

### 3.1 素材托盘（Material Tray）
```
素材（最多 9 张 · wan2.7-image）
┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
│ 图1  │ │ 图2  │ │ 图3  │ │  +   │
│ 主体 │ │ 风格 │ │ 背景 │ │ 添加 │
└──────┘ └──────┘ └──────┘ └──────┘
  ↑角标=序号  ↑角色标签（可点选/自动推断）
```
- **拖拽排序 = 图1/图2/图3 的编号**（角标实时更新；提示词里的"图2"跟着变）
- 每张素材可标**角色**：主体 / 风格 / 背景 / 姿势 / 服装 / 线稿 / 参考（默认"参考"；留空则纯序号）
- 素材来源（统一下拉/拖拽入口）：本地上传 · 从作品历史选 · 从灵感库选 · 从剪贴板粘贴 · **从合成画布送过来**
- hover 显示：替换、删除、下载、"设为第1张"
- 超出模型上限时：多余槽位置灰 + 提示"当前模型最多 3 张参考图"

### 3.2 提示词区（引用即点即插）
- 输入框上方一排 chip：`图1` `图2` `图3`…，点击即把「图2」插入光标处
- 预置模板（点开即填，可编辑）：
  - 换风格："保持图1的主体与构图，用图2的风格与色彩重绘"
  - 换背景："把图1的主体放到图2的场景中，光影与透视自然融合"
  - 服装替换："让图1的人物穿上图2的服装，保持人物面部与姿势不变"
  - 多图组图："参考图1的角色与图2的场景，生成 4 张同一角色的连续画面"
- 每组模板右上角标"推荐模型"（如组图 → wan2.7-image-pro）

### 3.3 与现有界面的关系
- 现在创作页的「文生图 / 图生图」Segmented 改为：**文生图 / 素材融合**（"图生图"是"素材融合"的单素材特例，语义更准）
- 单张素材时行为与现在完全一致（向后兼容）

---

## 4. 技术设计

### 4.1 IPC 契约
```ts
// before
interface GenOpts { …, ref?: { name: string; data: ArrayBuffer } }
// after
interface RefImage { name: string; data: ArrayBuffer; role?: 'subject'|'style'|'background'|'pose'|'outfit'|'sketch'|'ref'; source?: 'upload'|'history'|'library'|'compose'|'clipboard' }
interface GenOpts { …, refs?: RefImage[] }   // ref 保留兼容一版，内部归一化为 refs
```

### 4.2 主进程 http.ts（新增/改动）
```ts
// 能力注册表
const IMAGE_PROTOCOL: Record<string, { protocol: 'dashscope-multimodal' | 'openai-images'; maxRefs: number }> = {
  'wan2.7-image':      { protocol: 'dashscope-multimodal', maxRefs: 9 },
  'wan2.7-image-pro':  { protocol: 'dashscope-multimodal', maxRefs: 9 },
  'qwen-image-3.0':    { protocol: 'openai-images',        maxRefs: 3 },
  'qwen-image-3.0-pro':{ protocol: 'openai-images',        maxRefs: 3 },
  default:             { protocol: 'openai-images',        maxRefs: 1 }
}

// A) DashScope 原生（wan2.7 系）：content 里按顺序 push 多张 image
export async function httpBailianImage(o: { refs?: RefImage[]; … })   // ref → refs 数组化，content: refs.map(r => ({image: dataUri(r)})) + {text}

// B) OpenAI 兼容（qwen-image-3.x）：平铺参数，image 传数组
export async function httpImageOpenAI(o: { apiBase; apiKey; model; prompt; refs?; w; h; n?; negative?; seed? })
// body: { model, prompt, image: refs.length ? refs.map(dataUri) : undefined, size: `${w}x${h}`, n, negative_prompt, seed, watermark:false }
// 解析 data[0].url / b64_json → 下载落盘
```

### 4.3 落盘与复现（关键）
sidecar 记录素材清单，历史页「复现」才能还原多素材：
```json
{
  "prompt": "把图2的涂鸦喷绘在图1的汽车上",
  "refs": [
    { "order": 1, "role": "subject", "source": "history", "file": "image_1790695007671.png" },
    { "order": 2, "role": "style",   "source": "upload",  "file": "assets_xxx.png" }
  ],
  "model": "wan2.7-image", "provider": "bailian", "w": 1024, "h": 1024, "seed": 42
}
```
- 上传的素材需**留档**：上传即复制到 `userData/refs/<sha1>.<ext>`（内容寻址，天然去重），sidecar 只记 hash → 复现时不依赖原文件是否还在
- 「复现」按钮：从 refs 还原托盘（含顺序与角色），提示词回填

### 4.4 Agent 扩展
`edit_image` 工具参数增加 `images`（1-based 序号数组，引用当前素材池）：
```json
{ "tool": "edit_image", "params": { "prompt": "把图2的帽子戴到人物头上", "images": [1, 2] } }
```
- 无素材池时，`images` 缺省 = 上一步产出（兼容现状）
- 规划提示词同步说明"可用素材池：图1=主体, 图2=风格…"

### 4.5 成本与限制提示
- wan2.7 按**成功张数**计费；`enable_sequential=true`（组图）时 `n` = 最大张数（≤12）
- 前端在"生成"按钮旁显示预估："1 张 · ¥0.2" 或 "组图最多 4 张 · ¥0.8"
- 单图限制：≤20MB、宽高 240–8000、宽高比 1:8–8:1（qwen-image：单图 ≤10MB、384–2048px）

---

## 5. 实施拆解

| 批次 | 内容 | 文件 | 说明 |
|---|---|---|---|
| M1 | 主进程：`refs[]` 契约 + 双协议多图（wan2.7 / qwen-image-3.x）+ sidecar refs + 素材留档 | `http.ts`、`index.ts`、`providers.ts` | 核心，必须先做 |
| M2 | 创作页素材托盘（拖拽排序、角标、角色、多来源）+ 引用 chip + 模板 | `CreateView.tsx`、CSS | 交互主体 |
| M3 | 历史「复现」还原多素材 + 生成页显示 refs | `HistoryView.tsx`、sidecar 解析 | 闭环 |
| M4 | 合成页「送到创作页」+ Agent `images` 参数 | `ComposeView.tsx`、`agent.ts`、`tools.ts` | 联动 |
| M5 | 组图模式（`enable_sequential`）+ 成本预估 | `http.ts`、`CreateView.tsx` | 增值 |

**验收点**：① 单素材行为不回退 ② 2–9 张素材融合出图 ③ 超出模型上限的提示 ④ 复现能还原素材顺序与角色 ⑤ Agent 能用"图2"指代素材

---

## 6. 待决策

1. 是否先做 **M1+M2**（可用闭环），还是等设置页改完再一起做？
2. 角色标签：**手选**（默认"参考"）还是**交给模型自动理解**（不做标签，仅序号）？建议先做序号 + 可选标签。
3. 是否需要"组图"（一次出多张连续画面）作为第一版能力？
