# 妙绘工作台 · GitHub 生态调研（图像创作方向）

> 调研日期：2026-10-03 ｜ 方法：GitHub CLI 精确检索（`gh search repos` / `gh api`，含 topic 过滤与精确星数、许可、活跃度）+ 联网盘点交叉验证
> 数据口径：star 数与 `pushed_at` 为 2026-10-03 抓取快照
> 用途：为妙绘（Electron + React 19 + antd + Konva 桌面 AI 生图客户端）确定**可借鉴的架构**、**可集成的能力模块**与**许可红线**

---

## 0. 一句话结论

桌面 AI 创作客户端正在从「聊天框 + 生图」演进到 **「无限画布 + 本地 Agent + 可视化工作流」**（Toonflow / JarvisHub / openpencil 三条独立战线都是这个方向），同时**提示词资产正在 skill 化/库化**（GPT-Image2-Skill / RedInk / Awesome-Nano-Banana）。
妙绘目前的定位（国产模型 + 中文工作台 + 灵感库/反推/合成一体化）不冲突，但**画布能力与本地模型能力是最该补的两块**。

---

## 1. 直接同类：桌面 AI 创作客户端/工作台

| 项目 | Stars | 栈 | 许可 | 与妙绘的关系 |
|---|---|---|---|---|
| [HBAI-Ltd/Toonflow-app](https://github.com/HBAI-Ltd/Toonflow-app) | 16.4k | TypeScript | **MIT** | ⭐ 最像：无限画布 + AI Agent + 可视化工作流 + 跨平台桌面，可读可借鉴（含分镜/短剧） |
| [11cafe/jaaz](https://github.com/11cafe/jaaz) | 6.7k | TypeScript | 自定义(NOASSERTION) | 开源多模态创作助手（对标 Canva），本地+云端模型混合；**许可需自行确认** |
| [ZSeven-W/openpencil](https://github.com/ZSeven-W/openpencil) | 6.1k | Rust | **MIT** | AI 原生矢量设计工具，2026-10 仍在高频更新，矢量/图层模型可参考 |
| [LYL1015/JarvisHub](https://github.com/LYL1015/JarvisHub) | 611 | TypeScript | **Apache-2.0** | ⭐ 「画布原生多模态创作 Agent harness」，与妙绘 Compose+Agent 方向完全同构 |
| [3inchtime/astro_studio](https://github.com/3inchtime/astro_studio) | 3 | Rust/React | MIT | Tauri 2 跨平台生图客户端（GPT Image 等），Tauri 路线参考 |
| [CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio) | 52.3k | TypeScript | **AGPL-3.0** | 我们设置页/多供应商架构的对标物（**只可读思路，代码不可抄**） |
| [chatboxai/chatbox](https://github.com/chatboxai/chatbox) | 41.9k | TypeScript | GPL-3.0 | 桌面 AI 客户端 UX 参考 |
| [LibreChat-AI/LibreChat](https://github.com/LibreChat-AI/LibreChat) | 45.2k | TypeScript | **MIT** | 多供应商/会话管理，可直接读代码 |
| [Anil-matcha/Open-Generative-AI](https://github.com/Anil-matcha/Open-Generative-AI) | 29.6k | JavaScript | **MIT** | 图+视频生成的开源"无限制"替代（偏 Web） |

---

## 2. 本地引擎与节点工作流（若走「本地模型」路线）

| 项目 | Stars | 许可 | 备注 |
|---|---|---|---|
| [Comfy-Org/ComfyUI](https://github.com/Comfy-Org/ComfyUI) | 136.0k | GPL-3.0 | 节点式事实标准；**可对接（HTTP API）不可抄代码** |
| [AUTOMATIC1111/stable-diffusion-webui](https://github.com/AUTOMATIC1111/stable-diffusion-webui) | 165.2k | AGPL-3.0 | 老牌 WebUI |
| [invoke-ai/InvokeAI](https://github.com/invoke-ai/InvokeAI) | 28.3k | **Apache-2.0** | ⭐ 大引擎里唯一宽松许可：canvas/boards/图层模型值得精读 |
| [lllyasviel/Fooocus](https://github.com/lllyasviel/Fooocus) | 53.3k | GPL-3.0 | "只提示词"极简路线 |
| [LykosAI/StabilityMatrix](https://github.com/LykosAI/StabilityMatrix) | 8.9k | (C#) | 模型/包管理器思路（对应我们的"模型目录"） |
| [Comfy-Org/ComfyUI_frontend](https://github.com/Comfy-Org/ComfyUI_frontend) | 2.0k | GPL-3.0 | Vue 节点编辑器实现参考 |

---

## 3. 能力模块：按妙绘的短板逐项对应

### 3.1 抠图 / 去背景
| 项目 | Stars | 许可 | 借鉴点 |
|---|---|---|---|
| [danielgatis/rembg](https://github.com/danielgatis/rembg) | 25.0k | **MIT** | 经典方案（U2Net/ISNet），ONNX 可直接跑 |
| [ZhengPeng7/BiRefNet](https://github.com/ZhengPeng7/BiRefNet) | 4.2k | **MIT** | ⭐ RMBG-2.0 底座，发丝级精度，ONNX 权重可推理 |
| [imgly/background-removal-js](https://github.com/imgly/background-removal-js) | 7.3k | 见仓库 | 妙绘**已集成**（transformers.js/ONNX） |
| [addyosmani/bg-remove](https://github.com/addyosmani/bg-remove) | 1.0k | — | 纯浏览器 Transformers.js 实现，代码结构参考 |

### 3.2 局部重绘 / 擦除（妙绘"合成/蒙版"最大短板）
| 项目 | Stars | 许可 | 借鉴点 |
|---|---|---|---|
| [Sanster/IOPaint](https://github.com/Sanster/IOPaint) | 23.3k | **Apache-2.0** | ⭐⭐ SOTA 擦除/替换，含 LaMa 等模型；本地服务化或移植 ONNX |
| [zuruoke/watermark-removal](https://github.com/zuruoke/watermark-removal) | 5.2k | — | inpainting 去水印 |
| 云端替代 | — | — | 百炼 wan2.7 已支持 `bbox_list` 交互式编辑 / 局部重绘 API（无需本地模型，成本可控） |

### 3.3 超分辨率 / 放大
| 项目 | Stars | 许可 | 借鉴点 |
|---|---|---|---|
| [upscayl/upscayl](https://github.com/upscayl/upscayl) | 50.1k | AGPL-3.0 | 桌面 UX/批处理流程参考（**代码不可用**） |
| [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) | 37.0k | BSD-3 | 通用放大模型，ncnn/ONNX 版本可嵌入 |
| [chaiNNer-org/chaiNNer](https://github.com/chaiNNer-org/chaiNNer) | 6.1k | GPL-3.0 | 节点式图像处理链（思路参考） |

### 3.4 图像反推 / 打标（妙绘「提示词反推」的本地化）
| 项目 | Stars | 许可 | 借鉴点 |
|---|---|---|---|
| [m87-labs/moondream](https://github.com/m87-labs/moondream) | 10.1k | **Apache-2.0** | ⭐ 微型 VLM（<2B），CPU 可跑 → 离线反推的最优解 |
| [OpenBMB/MiniCPM-V](https://github.com/OpenBMB/MiniCPM-V) | 26.5k | **Apache-2.0** | 端侧多模态，标注/描述质量更高一档 |
| [QwenLM/Qwen3-VL](https://github.com/QwenLM/Qwen3-VL) | 20.0k | **Apache-2.0** | 我们线上反推所用的同族模型（本地权重路线） |
| [fpgaminer/joycaption](https://github.com/fpgaminer/joycaption) | 1.3k | **Apache-2.0** | ⭐ 专为训练/生图提示词设计的 caption VLM，输出风格最贴生图 |
| [pharmapsychotic/clip-interrogator](https://github.com/pharmapsychotic/clip-interrogator) | 3.0k | MIT | 经典 CLIP 反推 |
| [pythongosssss/ComfyUI-WD14-Tagger](https://github.com/pythongosssss/ComfyUI-WD14-Tagger) | 1.2k | MIT | 动漫向 tag 反推 |

### 3.5 图像工程（编码/压缩/元数据）
- [lovell/sharp](https://github.com/lovell/sharp) 32.7k **Apache-2.0** — 我们已在用（缩略图/格式转换）
- [GoogleChromeLabs/squoosh](https://github.com/GoogleChromeLabs/squoosh) 26.0k **Apache-2.0** — 压缩参数与视觉对比 UX 参考

### 3.6 画布 / 编辑器 UI
| 项目 | Stars | 许可 | 借鉴点 |
|---|---|---|---|
| [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) | 133.4k | **MIT** | 画布交互手感/协作模型 |
| [tldraw/tldraw](https://github.com/tldraw/tldraw) | 50.7k | 见 SDK 条款 | 无限画布 SDK（商用需读 license） |
| [swimmingkiim/react-image-editor](https://github.com/swimmingkiim/react-image-editor) | 553 | — | **React + Konva** 同栈图像编辑器（最贴我们的技术栈） |
| [allusion-app/Allusion](https://github.com/allusion-app/Allusion) | 904 | GPL-3.0 | 桌面图库：标签体系/相似图/批量整理（对应"灵感库/作品管理"） |

---

## 4. 提示词与素材资产（可直接打包进产品的"内容护城河"）

| 项目 | Stars | 许可 | 可直接用的部分 |
|---|---|---|---|
| [PicoTrex/Awesome-Nano-Banana-images](https://github.com/PicoTrex/Awesome-Nano-Banana-images) | 23.8k | **Apache-2.0** | 案例图+提示词合集 |
| [EvoLinkAI/awesome-gpt-image-2-API-and-Prompts](https://github.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts) | 17.3k | **CC0-1.0** | ⭐ 无版权限制，可自由内置 |
| [jamez-bondos/awesome-gpt4o-images](https://github.com/jamez-bondos/awesome-gpt4o-images) | 8.2k | — | 案例集 |
| [wuyoscar/GPT-Image2-Skill](https://github.com/wuyoscar/GPT-Image2-Skill) | 5.6k | **MIT** | ⭐ 提示词 gallery + agent skill + CLI 三态组织方式 |
| [HisMax/RedInk](https://github.com/HisMax/RedInk) | 5.6k | 自定义 | 小红书图文生成一体机（Nano Banana Pro）→ 中文场景产品化参考 |
| [Moonvy/OpenPromptStudio](https://github.com/Moonvy/OpenPromptStudio) | 6.7k | — | 提示词可视化编辑器（分类/权重） |

> 本机已有可复用 skill：`gpt-image-2-style-library`、`nanobanana-prompts`、`handdraw-style-prompter`（均为提示词资产层）

---

## 5. 许可红线（决定"能否抄代码"）

**可自由借鉴/集成（MIT / Apache-2.0 / BSD / CC0）**
LibreChat · NextChat · Toonflow-app · openpencil · JarvisHub · InvokeAI · IOPaint · rembg · BiRefNet · Real-ESRGAN · moondream · MiniCPM-V · Qwen3-VL · joycaption · clip-interrogator · WD14-Tagger · sharp · squoosh · excalidraw · Awesome-Nano-Banana · awesome-gpt-image-2 · GPT-Image2-Skill

**只可读思路，代码不可复制（AGPL / GPL / 自定义）**
Cherry Studio(AGPL) · Chatbox(GPL) · ComfyUI(GPL) · A1111(AGPL) · Fooocus(GPL) · Upscayl(AGPL) · chaiNNer(GPL) · Allusion(GPL) · NanoBananaEditor(AGPL) · jaaz/RedInk/lobehub(tldraw) 等 NOASSERTION → **必须逐字读 LICENSE 才能用**

> 妙绘目前未开源（`private: true`）。若未来不开源：上述 AGPL/GPL 项目只能"参考交互与架构思路"，不能复制代码；若未来开源且选 AGPL 兼容许可，则可放宽。

---

## 6. 给妙绘的落地建议（按性价比排序）

### 第一梯队（低成本、立即可做）
1. **离线反推**：引入 moondream / JoyCaption 的 ONNX 版本，作为"本地反推（免费、隐私）"选项；当前反推必须联网 + 消耗百炼额度。已有 `onnxruntime-node` / `transformers.js` 依赖，增量最小。
2. **提示词资产内置**：把 CC0/Apache-2.0 的案例库（awesome-gpt-image-2、Awesome-Nano-Banana）转成妙绘"风格/模板库"，扩充现有灵感库。
3. **抠图升级**：BiRefNet(MIT) 作为现有 `@imgly/background-removal` 的高精度档，A/B 可选。

### 第二梯队（能力补齐）
4. **局部重绘/擦除**：优先走百炼 `bbox_list` 交互式编辑（零本地依赖、即刻可用）；后续可挂 IOPaint 本地服务做离线版。
5. **超分**：Real-ESRGAN（BSD）本地放大，或百炼图像超分 API；UX 抄 Upscayl 的批处理。
6. **图库/灵感库标签体系**：参考 Allusion（思路）与 Immich 的检索模型，给作品/案例加标签、相似图、以图搜图。

### 第三梯队（架构演进，对标行业方向）
7. **无限画布 + Agent**：精读 Toonflow-app（MIT）与 JarvisHub（Apache-2.0）的信息架构；妙绘 ComposeView 可从"图层合成"升级为"画布 + 多轮 Agent 修改"。
8. **InvokeAI 的 canvas/boards 模型**（Apache-2.0）可作为图层/历史/分支的参考实现。
9. **工作流可视化**：若做批量/多步流程，参考 ComfyUI 的图模型（仅思路）或 chaiNNer 的节点 UX。

### 不建议做
- 不要自建本地扩散引擎（ComfyUI 生态已绝对垄断），只做**对接**（HTTP/WebSocket 代理包装成妙绘的"本地引擎"供应商）。
- 不要复制 AGPL/GPL 代码进未开源产品。

---

## 7. 调研方法与可复现命令

```powershell
# 精确星数/许可/活跃度
gh api repos/CherryHQ/cherry-studio | ConvertFrom-Json | Select stargazers_count,language,license,pushed_at

# 按 topic 排序检索（避开关键词噪音）
gh search repos --topic=text-to-image --sort stars --limit 12
gh search repos --topic=comfyui --sort stars --limit 8

# 注意：PowerShell 5.1 下 gh 的 --jq 传参会被吞引号，改用 --json + ConvertFrom-Json
```

> 检索教训：多词关键词直接排序（如 "AI 绘画"）会带进 NSFW 模板、政治类等无关仓库；应改用 **topic 过滤 + 精确仓库名核对**。
