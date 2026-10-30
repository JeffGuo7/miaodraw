# P0 提示词质量层 · 交付报告

提交：miaodraw `04d16aa`；Pixelle `33ec01e`（省钱档在 `9c09450` / `3dbff69`）

## 一、改动文件

| 文件 | 作用 |
|---|---|
| `src/main/prompt-guards.ts`（新） | 失败卡 14 条 / 厂商卡 / 海报配方组装 / 黑名单 / 台词密度 / 编造检测 / 原句保真 / 中性化 |
| `src/main/prompt-guards.test.mjs`（新） | 11 项纯函数单测（含 A/B 反例） |
| `src/main/tools.ts` | 规则进 `plannerSystem()`：保真、媒介锁、否定项只放 negative、文字只写确切文案、厂商参考图上限 |
| `src/main/agent.ts` | 每步执行前审计；命中编造 → 换参数重试一次；参考图超上限先告知再截断 |
| `src/main/http.ts` | `imageCapability` 统一取厂商卡；修复 z-image-turbo 返回体无 `type` 导致图片被丢弃 |
| `src/renderer/src/canvas/videoGeneration.ts` | 出片前黑名单 + 密度提示 |
| Pixelle `utils/vo_rules.py`（新） | 台词密度硬指标 + 黑名单正则 + 重写提示 |
| Pixelle `prompts/topic_narration.py` / `content_narration.py` | 两条旁白 prompt 注入密度+黑名单硬约束 |
| Pixelle `utils/content_generators.py` | 生成后命中黑名单 → 改提示词重写一次（两条生成路径） |

## 二、prompt 组装前后对比（Painter A/B 同一题）

**改前（口语原句直投）**
```
新中式茶馆春季招募海报，可以加点暖色，要醒目点
```
实测后果：模型自行改写主标题（春水煎茶→春水初生、招募茶艺师→招贤纳士），并**编造**品牌名「隐山·茶事」、电话 010-8888-6666、邮箱、杭州西湖区地址、五险一金。

**改后（`buildImagePrompt` 组装，191 字符）**
```
新中式茶馆春季招募海报，可以加点暖色，要醒目点
Medium: 平面设计海报。，1024x1024，色彩比例：主色茶汤琥珀约 60-70%，辅色宣纸米白约 20-30%，
高光金色描边约 5-10%，并交代明暗层次位置，版式方向：信息阶梯，画内文字仅限：「春水煎茶」、
「招募茶艺师」，逐字照排；其余区域留白，文字内容以上述引号内文案为准，不得新增或改写任何
品牌名、联系方式、价格、承诺
```

组装后审计（`SHOT_P0_PROMPT`）：`noFalsePositive=true`（无误报）。

## 三、校验能力（对 A/B 反例）

对上面那段编造草稿跑 `auditPlannedPrompt`：
```
detectsFabrication=true
fabricationKinds=["电话","邮箱","地址","价格","福利承诺"]
missingPhrases=["春水煎茶","招募茶艺师"]
```
命中后 `agent.ts` 的行为：剔除未确认事实（置空，不编造替代）→ 补回用户原句约束 →
**补 negative 守卫后换参数重试一次**（不是重复抽卡）。

## 四、验证与花费

- 单测 50/50（其中 prompt 层 11）；`typecheck` / `build` 通过。
- 四钩子回归：`SHOT_CANVAS` / `SHOT_CANVAS_DRAG` / `SHOT_CANVAS_CONNECT` / `SHOT_PLAN_O1` 全 ok；
  另有 `SHOT_CANVAS_GEN`(38s) / `SHOT_CANVAS_I2I`(2 张 76s) / `SHOT_P0_PROMPT` 通过。
- 付费：z-image-turbo 2 次 ≈ ¥0.2（≤¥0.5 上限内）；**未调用任何视频接口**。
