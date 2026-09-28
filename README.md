# 妙绘工作台 (MiaoDraw)

标准桌面客户端的 AI 图像创作平台，阿里云百炼 API 驱动。Electron + React + Ant Design，工程架构对齐 electron-vite 标准脚手架。

## 功能

- **创作**：文生图 / 图生图（拖入参考图改图），模型与尺寸可选（¥0.04~0.27/张），种子复现，负面提示词
- **灵感库**：内置约 2000 个提示词案例（含示例图），分类 / 搜索 / 分页，一键"用提示词创作 / 以此图作参考 / 蒸馏"
- **提示词反推**：任意图片 → qwen3-vl-plus 视觉模型反推出通用提示词，可粘贴到 Midjourney / 即梦 / SD 等任意生图产品
- **历史记录**：本地作品回看、保存、打开位置、再次创作

## 前置条件

1. 已安装 Node.js（开发机为 v24）
2. 已安装并登录百炼 CLI：`npm i -g bailian-cli && bl auth login`

## 运行

```cmd
start.cmd
```

或手动：

```cmd
npm install
npm run app        &rem 类型检查 + 构建 + 启动
npm run dev        &rem 开发模式（HMR 热更新）
```

## 打包安装程序

```cmd
npm run build:win
```

## 架构

```
┌────────────────────────────────────────────┐
│ Electron 主进程  src/main                    │
│  · bl CLI 调度（generate/edit/distill）      │
│  · media:// 协议：安全读取本地图片            │
│  · IPC: health/generate/distill/library/    │
│         history/settings/save/reveal        │
├────────────────────────────────────────────┤
│ 预加载脚本        src/preload                │
│  · contextBridge 暴露 window.api            │
├────────────────────────────────────────────┤
│ 渲染进程         src/renderer                │
│  · React 19 + Ant Design 5（暗色主题）       │
│  · 创作 / 灵感库 / 提示词反推 / 历史记录      │
└────────────────────────────────────────────┘
              │ spawn (ELECTRON_RUN_AS_NODE)
              ▼
   百炼 CLI (bailian-cli) → DashScope API
   · qwen-image-3.0 / wanx2.0-t2i-turbo  生图改图
   · qwen3-vl-plus                        提示词反推
```

- **无本地 HTTP 服务**：渲染进程通过 IPC 与主进程通信，图片通过自定义 `media://` 协议展示（带目录逃逸校验）
- **案例库**：`library/` 目录（libA 精选 md 案例 + libB 全能 json 案例），打包时经 extraResources 随应用分发
- **验收测试**：`npm run shot`（构建 + 截图退出）；`SHOT_VIEW=library|distill|history`、`SHOT_GEN=1`、`SHOT_DISTILL=1` 可做分页面 / 全链路自动验收

## 配置

| 位置 | 说明 |
|---|---|
| `src/main/bl.ts` | 百炼 CLI 入口路径（默认 `C:\nvm4w\nodejs\...`，可用环境变量 `BL_ENTRY` 覆盖） |
| `src/renderer/src/views/CreateView.tsx` | 模型与尺寸选项 |
| 运行时 | 模型/尺寸选择自动持久化到 `%APPDATA%/miaodraw/settings.json` |

## 旧版说明

`../qwen-workbench-demo/` 为早期 Python + ComfyUI 方案，已被本项目取代，仅作历史参考。
