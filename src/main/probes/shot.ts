/**
 * SHOT 截图验收探针（TEST_MODE=screenshot）—— 从 src/main/index.ts 抽出。
 *
 * 抽出原因：原实现是入口文件里的 1789 行（占 55%），每次改 UI 都要翻这个大文件，
 * 且探针随生产 bundle 分发。现在只在 TEST_MODE 下动态 import，入口只留一行加载。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { auditPlannedPrompt, buildImagePrompt } from '../prompt-guards'
// ---------- 验收截图模式（与 aodl-pilot 的 TEST_MODE 同思路） ----------
// 侧栏一级导航顺序（compose 已降级为画布内入口，不再占菜单位）
const VIEW_INDEX: Record<string, number> = { create: 0, canvas: 1, library: 2, distill: 3, history: 4, settings: 5 }

/** smoke 断言：记录每个验收点的结果，ERR/异常计入失败，最终决定退出码 */
let shotErrors = 0
function check(label: string, v: unknown): void {
  const s = String(v)
  if (s.startsWith('ERR') || s.includes('"err"')) {
    shotErrors++
    console.log(`[shot] FAIL ${label}:`, s.slice(0, 200))
  } else {
    console.log(`[shot] ok   ${label}:`, s.slice(0, 200))
  }
}

export interface ProbeCtx {
  /** 主窗口 */
  win: BrowserWindow
  /** 应用根目录（index.ts 的 APP_ROOT = app.getAppPath()） */
  appRoot: string
}

/**
 * 跑截图验收探针（仅 TEST_MODE=screenshot 时由 index.ts 动态加载）。
 * 探针内部会自行 app.exit，调用方不需要等返回值。
 */
export async function runScreenshotProbes(ctx: ProbeCtx): Promise<void> {
  const w = ctx.win
  const APP_ROOT = ctx.appRoot
  w.webContents.on('console-message', (_e, _level, message) => {
    if (message.toLowerCase().includes('error')) console.log('[renderer]', message.slice(0, 300))
  })
  // 整体看门狗：默认 90s 后强制截图退出（超时计为失败）；短视频/长任务可用 SHOT_WATCHDOG_MS 延长
  const watchdogMs = Number(process.env.SHOT_WATCHDOG_MS || 0) || 90000
  const watchdog = setTimeout(
    () => {
      console.log('[shot] watchdog fired')
      void w.webContents
        .capturePage()
        .then((img) => fs.writeFileSync(process.env.SHOT_PATH || path.join(APP_ROOT, 'screenshot-client.png'), img.toPNG()))
        .catch(() => undefined)
        .finally(() => app.exit(1))
    },
    watchdogMs
  )
  await new Promise((r) => setTimeout(r, 3000))
  // 新 profile 首次启动会弹「新手引导」模态：它会拦截键盘/指针探针（? 键被守卫吃掉、点击落在遮罩上）。
  // 探针只验功能，不验引导，统一先跳过。
  await w.webContents
    .executeJavaScript(
      `(() => { const b = [...document.querySelectorAll('.ant-modal button')].find(x => (x.textContent || '').includes('跳过')); if (b) b.click(); return b ? 'skipped' : 'none' })()`
    )
    .catch(() => undefined)
  await new Promise((r) => setTimeout(r, 400))
  const view = process.env.SHOT_VIEW
  if (view && VIEW_INDEX[view] !== undefined) {
    await w.webContents.executeJavaScript(
      `document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX[view]}].click()`
    )
    await new Promise((r) => setTimeout(r, view === 'library' ? 90000 : 1500))
  }
  if (process.env.SHOT_GEN === '1') {
    const r = await w.webContents.executeJavaScript(
      `window.api.generate({
        prompt: '一只橘猫趴在旧书堆上打盹，温暖台灯光，水彩插画风格',
        model: 'wan2.7-image', provider: 'bailian', w: 1024, h: 1024
      }).then(x => 'OK:' + x.file).catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] generate:', r)
    check('generate', r)
    await w.webContents.executeJavaScript(
      `document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX.history}].click()`
    )
    await new Promise((r) => setTimeout(r, 4000))
  }
  // 多素材融合冒烟：从案例库取两张图作为素材，走 generate 的多图链路并校验 sidecar 记录
  if (process.env.SHOT_FUSE === '1') {
    const fused = await w.webContents.executeJavaScript(
      `(async () => {
        try {
          const a = await window.api.imageRead('media://local/lib-a/ad-creative_case174/output.jpg')
          const b = await window.api.imageRead('media://local/lib-a/ad-creative_case175/output.jpg')
          const ab = (u) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)
          const x = await window.api.generate({
            prompt: '把图2的排版与配色风格用到图1的内容上，融合成一张广告海报',
            model: 'wan2.7-image', provider: 'bailian', w: 1024, h: 1024,
            refs: [
              { name: 'case174.jpg', data: ab(a), role: 'subject', source: 'library' },
              { name: 'case175.jpg', data: ab(b), role: 'style', source: 'library' }
            ]
          })
          return 'OK:' + x.file
        } catch (e) { return 'ERR:' + e.message }
      })()`
    )
    console.log('[shot] fuse:', fused)
    check('fuse', fused)
    await w.webContents.executeJavaScript(
      `document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX.history}].click()`
    )
    await new Promise((r) => setTimeout(r, 3000))
  }
  // 复现冒烟：点历史最新一条的「复现」，验证多素材能从内容寻址留档还原创作者素材托盘
  if (process.env.SHOT_REPRO === '1') {
    await w.webContents.executeJavaScript(
      `document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX.history}].click()`
    )
    await new Promise((r) => setTimeout(r, 2500))
    const clicked = await w.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.repro-btn'); if (!b) return 'ERR:no-repro-button'; b.click(); return 'clicked' })()`
    )
    await new Promise((r) => setTimeout(r, 3500))
    const tray = await w.webContents.executeJavaScript(`document.querySelectorAll('.ref-item').length`)
    console.log('[shot] repro:', clicked, 'tray items:', tray)
    check('repro', clicked === 'clicked' && Number(tray) > 0 ? `OK:${tray}个素材已还原` : 'ERR:素材托盘未还原')
  }
  // 组图冒烟：enable_sequential 一次多张，校验 files 数组与全部落盘
  if (process.env.SHOT_BATCH === '1') {
    const batched = await w.webContents.executeJavaScript(
      `window.api.generate({
        prompt: '水彩插画风，一只橘猫在窗台上打盹。第一张：清晨；第二张：黄昏',
        model: 'wan2.7-image', provider: 'bailian', w: 1024, h: 1024,
        n: 2, sequential: true
      }).then(x => 'OK:' + (x.files ? x.files.length : 1) + '张 ' + x.file).catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] batch:', batched)
    const n = Number(String(batched).match(/OK:(\d+)张/)?.[1] ?? 0)
    check('batch', n > 1 ? `OK:组图 ${n} 张` : `ERR:组图未返回多张 (${batched})`)
  }
  // 图像编辑冒烟：自动生成蒙版 → 局部重绘（走异步任务链路 + 版本链接续）
  if (process.env.SHOT_EDIT === '1') {
    const edited = await w.webContents.executeJavaScript(
      `(async () => {
        try {
          const hist = await window.api.history()
          if (!hist || !hist.length) return 'ERR:no-history'
          const item = hist[0]
          const buf = await window.api.imageRead(item.url)
          const blob = new Blob([buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)])
          const url = URL.createObjectURL(blob)
          const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url })
          const off = document.createElement('canvas')
          off.width = img.naturalWidth
          off.height = img.naturalHeight
          const ctx = off.getContext('2d')
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, off.width, off.height)
          ctx.fillStyle = '#fff'
          ctx.beginPath()
          ctx.arc(off.width * 0.5, off.height * 0.35, Math.min(off.width, off.height) * 0.18, 0, Math.PI * 2)
          ctx.fill()
          const mBlob = await new Promise((res) => off.toBlob((b) => res(b), 'image/png'))
          const mask = await mBlob.arrayBuffer()
          const r = await window.api.imageEdit({ op: 'repaint', name: item.name, mask, prompt: '在涂抹区域画一个白色的蝴蝶结', runId: 'edit-smoke' })
          return 'OK:' + r.file + ' parent=' + (r.parent || '-')
        } catch (e) { return 'ERR:' + e.message }
      })()`
    )
    console.log('[shot] edit:', edited)
    check('edit', String(edited).startsWith('OK:') ? edited : `ERR:图像编辑失败 ${edited}`)
  }
  // 风格库冒烟：校验内置数据条数，并打开抽屉确认渲染
  if (process.env.SHOT_STYLES === '1') {
    const count = await w.webContents.executeJavaScript(
      `window.api.styles().then(d => 'OK:' + (d.count || 0) + '条/' + (d.groups ? d.groups.length : 0) + '组').catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] styles data:', count)
    await w.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.style-lib-btn'); if (b) b.click(); return !!b })()`
    )
    await new Promise((r) => setTimeout(r, 1800))
    const cards = await w.webContents.executeJavaScript(`document.querySelectorAll('.style-card').length`)
    console.log('[shot] styles cards:', cards)
    const n = Number(String(count).match(/OK:(\d+)条/)?.[1] ?? 0)
    check('styles', n > 100 && Number(cards) > 0 ? `OK:${n}条 · 抽屉渲染${cards}张卡片` : `ERR:风格库未就绪 (${count} / cards=${cards})`)
  }
  // 更新冒烟：校验更新检查链路（无 Release 时应返回「还没有发布」而不是报错），并打开「关于」页截图
  if (process.env.SHOT_UPDATE === '1') {
    const u = await w.webContents.executeJavaScript(
      `window.api.updateCheck().then(r => 'OK:' + JSON.stringify({ ok: r.ok, current: r.current, hasUpdate: r.hasUpdate || false, latest: r.latest || '', out: r.out || '' })).catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] update:', u)
    check('update', String(u).startsWith('OK:') ? u : `ERR:更新检查失败 ${u}`)
    await w.webContents.executeJavaScript(
      `document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX.settings}].click()`
    )
    await new Promise((r) => setTimeout(r, 1200))
    const clicked = await w.webContents.executeJavaScript(
      `(() => { const items=[...document.querySelectorAll('.sn-item')]; const about=items.find(i => /关于/.test(i.textContent || '')); if (about) about.click(); return !!about })()`
    )
    console.log('[shot] update about nav:', clicked)
    await new Promise((r) => setTimeout(r, 900))
  }
  // 更新下载冒烟（配合本地假更新源）：check → download，校验文件真的落盘且大小正确
  if (process.env.SHOT_UPDATE2 === '1') {
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        try {
          const info = await window.api.updateCheck()
          if (!info.ok) return 'ERR:check ' + (info.out || '')
          if (!info.hasUpdate) return 'ERR: 未识别到新版本 (' + info.current + ' vs ' + (info.latest || '-') + ')'
          const d = await window.api.updateDownload({ url: info.assetUrl, name: info.assetName, size: info.assetSize })
          return d.ok ? 'OK:' + info.latest + ' → ' + d.file : 'ERR:download ' + (d.out || '')
        } catch (e) { return 'ERR:' + e.message }
      })()`
    )
    console.log('[shot] update2:', r)
    check('update-download', String(r).startsWith('OK:') ? r : `ERR:下载链路失败 ${r}`)
  }
  // 本地反推冒烟：下载模型（首次）→ 本地出英文描述 → 文本模型改写中文
  if (process.env.SHOT_LOCAL === '1') {
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        try {
          const buf = await window.api.imageRead('media://local/lib-a/ad-creative_case174/output.jpg')
          const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
          const x = await window.api.distillLocal({ data: ab, name: 'case174.jpg', rewrite: true })
          return 'OK:' + String(x.prompt || '').slice(0, 80) + ' || raw=' + String(x.raw || '').slice(0, 60) + ' || rewritten=' + x.rewritten
        } catch (e) { return 'ERR:' + e.message }
      })()`
    )
    console.log('[shot] localDistill:', r)
    check('local-distill', String(r).startsWith('OK:') ? r : `ERR:本地反推失败 ${r}`)
  }
  if (process.env.SHOT_DISTILL === '1') {
    await w.webContents.executeJavaScript(
      `document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX.library}].click()`
    )
    await new Promise((r) => setTimeout(r, 7000))
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const img = document.querySelector('.lib-card img')
        if (!img) return 'ERR: no lib image'
        const buf = await window.api.imageRead(img.src)
        document.querySelectorAll('.ant-menu-item')[${VIEW_INDEX.distill}].click()
        await new Promise(r => setTimeout(r, 800))
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        const x = await window.api.distill({ data: ab, name: 'case.png' })
        return 'OK:' + x.prompt.slice(0, 80)
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] distill:', r)
    check('distill', r)
    await new Promise((r2) => setTimeout(r2, 1000))
  }
  if (process.env.SHOT_PAL === '1') {
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const out = {}
        try {
          out.items = document.querySelectorAll('.ant-menu-item').length
          const el = document.querySelectorAll('.ant-menu-item')[4]
          out.found = !!el
          el && el.click()
          await new Promise(r => setTimeout(r, 600))
          out.view = document.querySelector('.app-header .ant-typography')?.textContent || ''
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
          await new Promise(r => setTimeout(r, 1200))
          out.palOpen = !!document.querySelector('.pal')
        } catch (e) { out.err = e.message }
        return JSON.stringify(out)
      })()`
    )
    console.log('[shot] pal:', r)
    check('pal', r)
    await new Promise((r2) => setTimeout(r2, 800))
  }
  clearTimeout(watchdog)
  if (process.env.SHOT_AGENT === '1') {
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const x = await window.api.agentRun({
          runId: 'shot-agent',
          goal: '画一张日系清新的街角咖啡店门面，然后提高整体对比度',
          model: 'wanx2.0-t2i-turbo'
        })
        const chain = x.last ? await window.api.imageChain(x.last.file) : []
        return 'OK:' + JSON.stringify({ steps: x.files.length, reply: x.reply.slice(0, 50), chain: chain.length })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] agent:', r)
    check('agent', r)
    await new Promise((r2) => setTimeout(r2, 500))
  }
  if (process.env.SHOT_COMPOSE === '1') {
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const byText = (t) => [...document.querySelectorAll('button')].find(b => b.textContent.includes(t))
        byText('文字')?.click()
        await new Promise(r => setTimeout(r, 500))
        byText('导出 PNG')?.click()
        await new Promise(r => setTimeout(r, 1500))
        return 'clicked'
      })()`
    )
    console.log('[shot] compose:', r)
  }
  if (process.env.SHOT_CANVAS === '1') {
    // 画布工作台自测：点工具条新建三类节点，断言 DOM 中真的出现节点卡片
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        const made = []
        for (const t of ['文本', '图片', '视频']) {
          const b = byText(t)
          if (!b) return 'ERR: toolbutton ' + t + ' not found'
          b.click()
          made.push(t)
          await new Promise(r => setTimeout(r, 400))
        }
        await new Promise(r => setTimeout(r, 800))
        const nodes = document.querySelectorAll('[data-node-id]').length
        const toolbar = document.querySelector('.ivc-toolbar') ? 1 : 0
        return nodes >= 3 ? 'OK:nodes=' + nodes + ',toolbar=' + toolbar + ',clicked=' + made.join('/') : 'ERR:nodes=' + nodes
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas:', r)
    check('canvas', r)
  }
  if (process.env.SHOT_CANVAS_GEN === '1') {
    // 画布出图节点端到端自测：新建出图节点 → 填提示词 → 点生成 → 等图片卡落画布
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        const genBtn = byText('出图')
        if (!genBtn) return 'ERR: 工具条无出图按钮'
        genBtn.click()
        await sleep(600)
        const ta = document.querySelector('.ivc-gen-prompt')
        if (!ta) return 'ERR: 出图节点无提示词输入框'
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, '一只戴贝雷帽的柴犬，扁平插画风格，简洁背景')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(300)
        const run = [...document.querySelectorAll('.ivc-gen button')].find(b => b.textContent.includes('生成'))
        if (!run) return 'ERR: 无生成按钮'
        run.click()
        const t0 = Date.now()
        while (Date.now() - t0 < 70000) {
          await sleep(2000)
          const imgs = document.querySelectorAll('.ivc-img').length
          if (imgs > 0) return 'OK:canvas_images=' + imgs + ' in ' + Math.round((Date.now() - t0) / 1000) + 's'
          const err = document.querySelector('.ivc-gen-error')
          if (err) return 'ERR: ' + err.textContent.slice(0, 150)
        }
        return 'ERR: 70s 超时未出图'
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-gen:', r)
    check('canvas-gen', r)
  }
  if (process.env.SHOT_CANVAS_VIDEO === '1') {
    // V1 真实出片（付费 ≤¥2）：视频节点 → 默认 2 秒/720P → 成本确认卡 → 确认 → 等成片 → assets+血统边
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        const btn = byText('视频')
        if (!btn) return 'ERR: 工具条无视频按钮'
        btn.click()
        await sleep(700)
        const ta = document.querySelector('.ivc-gen-prompt')
        if (!ta) return 'ERR: 视频节点无提示词输入框'
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, '秋天午后，一只戴贝雷帽的柴犬坐在窗边看窗外落叶缓缓飘落，暖色调，电影感')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(300)
        const cost = document.querySelector('.ivc-video-cost')?.getAttribute('data-video-cost')
        const run = document.querySelector('[data-video-run="true"]')
        if (!run) return 'ERR: 无生成成片按钮'
        run.click()
        // 成本确认卡：必须出现，且金额与节点显示一致
        let modal = null
        for (let i = 0; i < 30; i++) { await sleep(200); modal = document.querySelector('.ant-modal-confirm'); if (modal) break }
        if (!modal) return 'ERR: 未出现成本确认卡'
        const modalText = modal.textContent || ''
        if (!modalText.includes('预估费用') || !modalText.includes(String(cost))) return 'ERR: 确认卡金额不符 ' + modalText.slice(0, 120)
        const t0 = Date.now()
        modal.querySelector('.ant-btn-primary')?.click()
        while (Date.now() - t0 < 600000) {
          await sleep(5000)
          const vid = document.querySelectorAll('video.ivc-video').length
          if (vid > 0) {
            // 入库断言：assets 行 + 血统边（operation=bailian-video）
            const db = await new Promise((res, rej) => { const rq = indexedDB.open('miaodraw-canvas'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error) })
            const all = (store) => new Promise((res, rej) => { const tx = db.transaction(store, 'readonly'); const rq = tx.objectStore(store).getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error) })
            const vids = (await all('assets')).filter(a => String(a.path || '').startsWith('videos/'))
            const last = vids[vids.length - 1]
            const deps = (await all('asset_dependencies')).filter(d => d.child_id === (last?.id || '') && d.operation === 'bailian-video')
            const meta = last ? JSON.parse(last.metadata || '{}') : {}
            // 本探针未连参考图 → 没有父产物，预期「零血统边」（不许凭空写边）；
            // 有父产物时的建边逻辑由 buildVideoLineage 单测覆盖（零成本）
            const depsOk = deps.length === 0
            const ok = vids.length >= 1 && !!last && last.size > 0 && depsOk && meta.source === 'bailian-video' && meta.duration_sec === 2
            return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ videos: vids.length, file: last?.path, size: last?.size, duration_ms: last?.duration_ms, parents: 0, deps: deps.length, depsOk, source: meta.source, model: meta.model, estimatedCny: meta.estimated_cny, seconds: Math.round((Date.now() - t0) / 1000) })
          }
          const err = document.querySelector('.ivc-gen-error')
          if (err) return 'ERR: ' + err.textContent.slice(0, 200)
        }
        return 'ERR: 600s 超时未出片'
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-video:', r)
    check('canvas-video', r)
  }
  if (process.env.SHOT_VIDEO_GUARD === '1') {
    // V1 成本护栏（零付费）：预估价显示 / 不确认不提交 / 硬上限 fail-closed
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        const btn = byText('视频')
        if (!btn) return 'ERR: 工具条无视频按钮'
        btn.click()
        await sleep(700)
        const ta = document.querySelector('.ivc-gen-prompt')
        if (!ta) return 'ERR: 视频节点无提示词输入框'
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, '成本护栏自测（不会真的提交任务）')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(200)
        const costEl = document.querySelector('.ivc-video-cost')
        const cost = costEl?.getAttribute('data-video-cost') ?? ''
        const costText = (costEl?.textContent || '').slice(0, 60)
        // ① 点生成 → 必须先出确认卡（金额一致），不确认不得提交
        const run = document.querySelector('[data-video-run="true"]')
        if (!run) return 'ERR: 无生成按钮'
        run.click()
        let modal = null
        for (let i = 0; i < 20; i++) { await sleep(150); modal = document.querySelector('.ant-modal-confirm'); if (modal) break }
        const modalText = modal ? modal.textContent || '' : ''
        const confirmShown = !!modal && modalText.includes('预估费用') && modalText.includes(String(cost))
        // ② 取消 → 无提交痕迹（无视频卡、无进度文案、无错误）
        modal?.querySelector('.ant-btn-default')?.click()
        await sleep(800)
        const videoCards = document.querySelectorAll('video.ivc-video').length
        const genText = document.querySelector('.ivc-gen')?.textContent || ''
        const submitted = /提交中|排队中|生成中/.test(genText) || !!document.querySelector('.ivc-gen-error')
        const noSubmit = videoCards === 0 && submitted === false
        // ③ 硬上限 fail-closed：主进程预估价超限直接拒（零付费，不会走到提交）
        let capError = ''
        try { await window.api.videoGenerate({ spec: { prompt: '硬上限自测', duration: 10, resolution: '1080P' } }) }
        catch (e) { capError = (e && e.message) || String(e) }
        const capBlocked = capError.includes('上限')
        const ok = cost === '1.20' && confirmShown && noSubmit && capBlocked
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ cost, costText, confirmShown, noSubmit, videoCards, submitted, capError: capError.slice(0, 120), capBlocked })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] video-guard:', r)
    check('video-guard', r)
  }
  if (process.env.SHOT_VIDEO_LINEAGE === '1') {
    // V1 落卡/入库/血统边（零成本）：stub 成片结果 + 播种「已入库父产物」→ 断言 assets 行 + derived 血统边
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        const openDb = () => new Promise((res, rej) => { const rq = indexedDB.open('miaodraw-canvas'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error) })
        const db = await openDb()
        const all = (store) => new Promise((res, rej) => { const tx = db.transaction(store, 'readonly'); const rq = tx.objectStore(store).getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error) })
        const btn = byText('视频')
        if (!btn) return 'ERR: 工具条无视频按钮'
        btn.click()
        await sleep(800)
        const ta = document.querySelector('.ivc-gen-prompt')
        if (!ta) return 'ERR: 视频节点无提示词输入框'
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, '血统边自测（零成本 stub，不会提交任务）')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(200)
        // 找一个已入库的图片资产当父产物（真实连线图片卡才有的形态）
        const parent = (await all('assets')).filter(a => String(a.path || '').startsWith('outputs/')).pop()
        if (!parent) return 'ERR: 库中没有可用图片资产'
        const host = [...document.querySelectorAll('[data-node-id]')].find(el => el.querySelector('.ivc-video-opts'))
        const nodeId = host?.getAttribute('data-node-id')
        if (!nodeId) return 'ERR: 找不到视频节点'
        window.__videoTest.seedParent(nodeId, 'media://local/out/' + encodeURIComponent(String(parent.path).slice('outputs/'.length)), parent.id)
        await sleep(300)
        const stub = await window.api.videoDebugStub()
        window.__videoTest.setStub(stub)
        const run = document.querySelector('[data-video-run="true"]')
        if (!run) return 'ERR: 无生成按钮'
        run.click()
        let modal = null
        for (let i = 0; i < 20; i++) { await sleep(150); modal = document.querySelector('.ant-modal-confirm'); if (modal) break }
        if (!modal) return 'ERR: 未出现成本确认卡'
        modal.querySelector('.ant-btn-primary')?.click()
        await sleep(2500)
        const child = (await all('assets')).filter(a => a.path === stub.relPath).pop()
        const deps = (await all('asset_dependencies')).filter(d => d.child_id === (child?.id || '') && d.parent_id === parent.id)
        const edge = deps[0]
        const meta = edge ? JSON.parse(edge.metadata || '{}') : {}
        const videoCards = document.querySelectorAll('video.ivc-video').length
        const ok = !!child && child.duration_ms === 2000 && child.size > 0 && edge?.role === 'derived' && edge?.operation === 'bailian-video' && meta.source === 'bailian-video' && meta.duration_sec === 2 && videoCards >= 1
        window.__videoTest.setStub(null)
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ childPath: child?.path, childSize: child?.size, duration_ms: child?.duration_ms, parentPath: parent.path, deps: deps.length, role: edge?.role, operation: edge?.operation, meta, videoCards })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] video-lineage:', r)
    check('video-lineage', r)
  }
  if (process.env.SHOT_VIDEO_JOBS === '1') {
    // V1 地基（零成本）：video_jobs 幂等（硬约束①）+ 成本护栏 fail-closed（硬约束②）+ 记账落库 + IndexedDB 落盘
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1200)
        const api = window.api
        const P = 'probe-plan-v1', S = 'stage-shots'
        const ITEMS = [{ kind: 'image', price_key: 'z-image-turbo', qty: 3 }]
        const keyOf = (wi) => P + '|' + S + '|' + wi

        // ① 幂等：同三键 ensure 两次只有一条，且不覆盖已有进度
        const j1 = await api.videoDebugEnsure({ planId: P, stageId: S, workItemId: 'wi_a', kind: 'image', paid: true, shotIndex: 0 })
        await api.videoDebugAdvance({ planId: P, stageId: S, workItemId: 'wi_a', action: 'running' })
        const j1again = await api.videoDebugEnsure({ planId: P, stageId: S, workItemId: 'wi_a', kind: 'image', paid: true, shotIndex: 0 })
        const jobsAfterEnsure = await api.videoJobs({ planId: P, stageId: S })
        const idempotent = j1.id === keyOf('wi_a') && j1again.status === 'running' && jobsAfterEnsure.filter(x => x.id === keyOf('wi_a')).length === 1

        // ② done → 复用产物（绝不重复付费）
        await api.videoDebugAdvance({ planId: P, stageId: S, workItemId: 'wi_a', action: 'done', assetId: 'asset_a', costCny: 0.3 })
        const reuse = await api.videoDebugDecide({ planId: P, stageId: S, workItemId: 'wi_a' })

        // ③ 重试上限：连续失败 2 次 → blocked
        await api.videoDebugEnsure({ planId: P, stageId: S, workItemId: 'wi_b', kind: 'image', paid: true, shotIndex: 1 })
        await api.videoDebugAdvance({ planId: P, stageId: S, workItemId: 'wi_b', action: 'running' })
        await api.videoDebugAdvance({ planId: P, stageId: S, workItemId: 'wi_b', action: 'failed', error: 'e1' })
        await api.videoDebugAdvance({ planId: P, stageId: S, workItemId: 'wi_b', action: 'running' })
        await api.videoDebugAdvance({ planId: P, stageId: S, workItemId: 'wi_b', action: 'failed', error: 'e2' })
        const capped = await api.videoDebugDecide({ planId: P, stageId: S, workItemId: 'wi_b' })

        // ④ running → 先对账（不直接重提）
        await api.videoDebugEnsure({ planId: P, stageId: S, workItemId: 'wi_c', kind: 'tts', paid: false, shotIndex: 2 })
        await api.videoDebugAdvance({ planId: P, stageId: S, workItemId: 'wi_c', action: 'running' })
        const running = await api.videoDebugDecide({ planId: P, stageId: S, workItemId: 'wi_c' })

        // ⑤ 成本闸门：无凭证拒 / 有凭证过且作废 / 重放拒 / revision 漂移拒 / 超硬上限拒 / 价格缺失拒
        const noToken = await api.videoDebugAuthorize({ planId: P, stageId: S, revision: 1, items: ITEMS })
        const token = await api.videoDebugIssueToken({ planId: P, stageId: S, revision: 1, items: ITEMS })
        const okAuth = await api.videoDebugAuthorize({ planId: P, stageId: S, revision: 1, items: ITEMS })
        const replay = await api.videoDebugAuthorize({ planId: P, stageId: S, revision: 1, items: ITEMS, tokenOverride: token })
        // 每个负例都用新签发的凭证（已消费的凭证会先被一次性语义拦下，测不到后面的分支）
        await api.videoDebugIssueToken({ planId: P, stageId: S, revision: 1, items: ITEMS })
        const drifted = await api.videoDebugAuthorize({ planId: P, stageId: S, revision: 2, items: ITEMS })
        const bigItems = [{ kind: 'video', price_key: 'wan2.7-t2v@720P', seconds: 12 }]
        await api.videoDebugIssueToken({ planId: P, stageId: S, revision: 3, items: bigItems })
        const tooBig = await api.videoDebugAuthorize({ planId: P, stageId: S, revision: 3, items: bigItems })
        const unknownItems = [{ kind: 'video', price_key: 'kling-v9' }]
        await api.videoDebugIssueToken({ planId: P, stageId: S, revision: 3, items: unknownItems })
        const unpriced = await api.videoDebugAuthorize({ planId: P, stageId: S, revision: 3, items: unknownItems })

        // ⑥ 记账 + 审计：¥0.3 已入账，plan_events 有 video_paid
        const cost = await api.videoCost({ planId: P })
        const events = await api.planEvents(P)
        const auditOk = Array.isArray(events) && events.some(e => e.event === 'video_paid' && String(e.detail || '').includes('0.3'))

        // ⑦ 落盘：video_jobs 在 IndexedDB 里且条数与主进程一致
        const db = await new Promise((res, rej) => { const rq = indexedDB.open('miaodraw-canvas'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error) })
        const rows = await new Promise((res, rej) => { const tx = db.transaction('video_jobs', 'readonly'); const rq = tx.objectStore('video_jobs').getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error) })
        const mine = rows.filter(x => x.plan_id === P)
        const stores = Array.from(db.objectStoreNames)
        const persisted = stores.includes('video_jobs') && mine.length === jobsAfterEnsure.length + 2

        const ok = idempotent && reuse.action === 'reuse' && reuse.output_asset_id === 'asset_a' &&
          capped.action === 'blocked' && running.action === 'reconcile' &&
          noToken.code === 'COST_GATE_REQUIRED' && okAuth.ok === true && okAuth.tokenUsed === true &&
          replay.code === 'TOKEN_USED' && drifted.code === 'TOKEN_MISMATCH' && tooBig.code === 'BUDGET_EXCEEDED' &&
          unpriced.code === 'UNPRICED_REQUIRES_CONSENT' && cost.spent === 0.3 && auditOk && persisted
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({
          idempotent, reuse: reuse.action, reuseAsset: reuse.output_asset_id, capped: capped.action, running: running.action,
          noToken: noToken.code, okAuth: okAuth.ok, tokenUsed: okAuth.tokenUsed, replay: replay.code, drifted: drifted.code,
          tooBig: tooBig.code, unpriced: unpriced.code, spent: cost.spent, remaining: cost.remaining, budget: cost.budget,
          auditOk, persisted, rows: mine.length, stores: stores.filter(s => s.startsWith('video'))
        })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] video-jobs:', r)
    check('video-jobs', r)
  }
  if (process.env.SHOT_VIDEO_PLAN === '1') {
    // V1 主链纯函数（零成本）：video:plan 只预估不执行 + 分镜解析/文案检查卡校验
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1200)
        const api = window.api
        const P = 'probe-plan-v1b', S = 'stage-shots'
        const shots = [1, 2, 3, 4].map(i => ({ workItemId: 'wi_' + i, imagePrompt: '镜头' + i + '：秋天窗边的热茶，暖光' }))

        // ① 只预估不执行：4 镜头 → 4 图 + tts + compose；¥0.4 预估；不计账
        const plan = await api.videoPlan({ planId: P, stageId: S, revision: 2, narration: '秋天的午后，一杯热茶。', shots })
        const planOk = plan.shots === 4 && plan.jobs.filter(j => j.kind === 'image' && j.paid).length === 4 &&
          plan.jobs.some(j => j.kind === 'tts' && j.paid) && plan.jobs.some(j => j.kind === 'compose' && !j.paid) &&
          plan.estimatedCost === 0.4 && plan.unpriced === false && plan.modelMix.includes('z-image-turbo')
        const costAfterPlan = await api.videoCost({ planId: P })
        const noSpend = costAfterPlan.spent === 0
        const jobsAfterPlan = await api.videoJobs({ planId: P, stageId: S })

        // ② 分镜解析：围栏 JSON → 2 镜头、无 issue
        const good = await api.videoDebugParseScript({ llmText: '\\u0060\\u0060\\u0060json\\n{"title":"秋日茶事","shots":[{"narration":"秋天的午后","image_prompt":"暖色窗边热茶"},{"narration":"水汽升起","image_prompt":"茶面特写"}]}\\n\\u0060\\u0060\\u0060', shotCount: 2, shotSeconds: 3 })
        const goodOk = good.shots.length === 2 && good.issues.length === 0 && good.narration === '秋天的午后水汽升起'

        // ③ 文案检查卡：黑名单 + 密度超预算必须被记账（不静默放行）
        const bad = await api.videoDebugParseScript({ llmText: '{"title":"x","shots":[{"narration":"震惊！速成秘籍三天学会，绝对有效，第一第二第三第四第五第六第七第八第九第十","image_prompt":"a"}]}', shotCount: 1, shotSeconds: 3 })
        const badOk = bad.blacklist.length >= 1 && bad.issues.some(i => i.includes('黑名单')) && bad.issues.some(i => i.includes('密度'))

        // ④ 兜底：模型不吐 JSON 也要能出分镜（流程不断）
        const fb = await api.videoDebugParseScript({ llmText: '第一句。第二句。第三句。', shotCount: 3, shotSeconds: 3 })
        const fbOk = fb.shots.length === 3 && fb.issues.some(i => i.includes('兜底')) && fb.shots.every(s => s.image_prompt)

        const ok = planOk && noSpend && jobsAfterPlan.length === 0 && goodOk && badOk && fbOk
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ planOk, estimatedCost: plan.estimatedCost, jobs: plan.jobs.map(j => j.kind + (j.paid ? '$' : '')), unpriced: plan.unpriced, spent: costAfterPlan.spent, jobsAfterPlan: jobsAfterPlan.length, goodShots: good.shots.length, badBlacklist: bad.blacklist, badIssues: bad.issues.length, fallbackShots: fb.shots.length })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] video-plan:', r)
    check('video-plan', r)
  }
  if (process.env.SHOT_VIDEO_TTS_PROBE === '1') {
    // 诊断（非验收）：确认 TTS 端点/请求形态（失败请求不产生费用）
    const r = await w.webContents.executeJavaScript(
      `(async () => { try { return JSON.stringify(await window.api.videoDebugTtsProbe({ text: '接口自检' })) } catch (e) { return 'ERR:' + e.message } })()`
    )
    console.log('[shot] video-tts-probe:', r)
  }
  if (process.env.SHOT_VIDEO_E2E === '1') {
    // V1 真实成片（付费，2 镜头 ≈ ¥0.21）：预估 → 确认凭证 → 执行（script→shots→tts→compose）→ 幂等复跑不重复付费
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1200)
        const api = window.api
        const brief = '做一条短视频：秋天午后一杯热茶，安静治愈，不要口播只留画面'
        // ① 建计划 + 物化首阶段（免费）
        const created = await api.planCreate({ prompt: brief, canvasContext: { videoReady: true } })
        if (created.kind !== 'plan') return 'ERR: 未建计划 ' + JSON.stringify(created)
        const planId = created.planId
        const authored = await api.planAuthorStage({ planId })
        const snap = authored && authored.value ? authored.value : authored
        const stage = snap.stages && snap.stages[0]
        if (!stage) return 'ERR: 首阶段未物化 ' + JSON.stringify(authored).slice(0, 200)
        const ctx = { planId, stageId: stage.id, revision: stage.revision, brief, shotCount: 2, shotSeconds: 3, resolution: '720P' }

        // ② 预估（LLM 规划，无付费图片/视频请求）：拿到 shots/narration/items + 预估成本
        const plan = await api.videoPlan(ctx)
        if (!plan.shots || !plan.shots.length) return 'ERR: 预估未产出分镜 ' + JSON.stringify(plan).slice(0, 200)
        const estimateOk = plan.estimatedCost > 0 && plan.estimatedCost <= 0.4 && plan.unpriced === false && plan.budget.spent === 0

        // ③ 用户确认 → 一次性凭证（绑定 stageId/revision/付费项哈希）
        const token = await api.videoDebugIssueConfirmToken({ planId, stageId: stage.id, revision: stage.revision, items: plan.items })

        // ④ 执行：script→shots(图)→tts→compose
        const t0 = Date.now()
        const run = await api.videoRun({ ...ctx, confirmToken: token, prepared: { narration: plan.narration, shots: plan.shots } })
        const seconds = Math.round((Date.now() - t0) / 1000)

        // ⑤ 断言：成片存在 + 作业全 done + 记账 + 审计
        let finalSize = 0
        try { finalSize = (await api.canvasAssetInfo(run.finalRelPath)).size } catch (e) { finalSize = -1 }
        const jobs = await api.videoJobs({ planId, stageId: stage.id })
        const kinds = jobs.map(j => j.kind + ':' + j.status).sort()
        const cost = await api.videoCost({ planId })
        const events = await api.planEvents(planId)
        const auditOk = Array.isArray(events) && events.filter(e => e.event === 'video_paid').length >= 1 && events.some(e => e.event === 'video_compose')
        const paidImages = jobs.filter(j => j.kind === 'image' && j.paid).length
        const ok1 = run.ok === true && finalSize > 0 && jobs.every(j => j.status === 'done') && cost.spent > 0 && cost.spent <= 0.4 && paidImages === 2 && auditOk

        // ⑥ 幂等复跑（新凭证 + 同分镜）：已 done 的作业必须复用，付费调用 0 次
        const token2 = await api.videoDebugIssueConfirmToken({ planId, stageId: stage.id, revision: stage.revision, items: plan.items })
        const rerun = await api.videoRun({ ...ctx, confirmToken: token2, prepared: { narration: plan.narration, shots: plan.shots } })
        const costAfterRerun = await api.videoCost({ planId })
        const noExtraSpend = costAfterRerun.spent === cost.spent

        // ⑦ 重放同一凭证 → 拒绝（凭证一次性，杜绝重复付费）
        const replay = await api.videoRun({ ...ctx, confirmToken: token, prepared: { narration: plan.narration, shots: plan.shots } })

        const ok = estimateOk && ok1 && rerun.ok === true && noExtraSpend && replay.ok === false && replay.code === 'TOKEN_USED'
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({
          estimateOk, estimatedCost: plan.estimatedCost, items: (plan.items || []).length, shots: plan.shots.length,
          runOk: run.ok, final: run.finalRelPath, finalSize, seconds, jobs: kinds, spent: cost.spent, auditOk,
          rerunOk: rerun.ok, rerunSpent: costAfterRerun.spent, noExtraSpend, replayCode: replay.code,
          runReason: run.reason || null, rerunReason: rerun.reason || null
        })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] video-e2e:', r)
    check('video-e2e', r)
  }
  if (process.env.SHOT_VIDEO_UI === '1') {
    // V1 收尾（近零成本：仅一次分镜 LLM，约 ¥0.001）：计划卡上的成片面板 → 预估 → 取消不花钱 + 取消/续跑通道可用
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1200)
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        byText('对话').click()
        await sleep(400)
        const panel = document.querySelector('[data-testid="chat-panel"]')
        const ta = panel.querySelector('textarea')
        const setVal = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
        setVal(ta, '做一条短视频，要有分镜和口播')
        await sleep(150)
        ;[...panel.querySelectorAll('button')].find(b => b.textContent.includes('发送')).click()
        let card = null
        for (let i = 0; i < 40; i++) { await sleep(200); card = document.querySelector('[data-plan-id]'); if (card) break }
        if (!card) return 'ERR: 计划卡未出现'
        const planId = card.getAttribute('data-plan-id')
        // 物化到「成片」阶段（含 video work_item）
        let stagePanel = null
        for (let i = 0; i < 4 && !stagePanel; i++) {
          const authored = await window.api.planAuthorStage({ planId })
          await sleep(500)
          stagePanel = document.querySelector('[data-video-stage-panel="true"]')
          if (!stagePanel && authored && authored.ok === false) break
        }
        if (!stagePanel) return 'ERR: 成片阶段面板未出现（stage=' + document.querySelectorAll('[data-stage-id]').length + '）'
        const stageId = stagePanel.getAttribute('data-stage-id')
        const beginsIdle = stagePanel.getAttribute('data-video-phase') === 'idle'
        const planBtn = stagePanel.querySelector('[data-video-plan="true"]')
        if (!planBtn) return 'ERR: 无预估按钮'
        // ① 预估 → 出预估卡（金额 > 0），且此时不得有付费调用
        planBtn.click()
        let est = null
        for (let i = 0; i < 60; i++) { await sleep(500); est = document.querySelector('[data-video-estimate="true"]'); if (est) break }
        if (!est) return 'ERR: 预估卡未出现'
        const cost = Number(est.getAttribute('data-video-cost'))
        const costOk = Number.isFinite(cost) && cost > 0
        const spentBeforeRun = (await window.api.videoCost({ planId })).spent
        // ② 取消（不确认）→ 回到 idle，且没有任何付费与作业
        est.querySelector('[data-video-discard="true"]').click()
        await sleep(600)
        const backToIdle = document.querySelector('[data-video-stage-panel="true"]')?.getAttribute('data-video-phase') === 'idle'
        const jobs = await window.api.videoJobs({ planId, stageId })
        const spentAfter = (await window.api.videoCost({ planId })).spent
        const noSpend = spentBeforeRun === 0 && spentAfter === 0 && jobs.length === 0
        // ③ 取消 / 续跑通道可用（零成本，直接走 IPC）
        const cancel = await window.api.videoCancel({ planId, stageId })
        const resume = await window.api.videoResume({ planId, stageId, jobs: [] })
        const channelsOk = cancel?.ok === true && resume?.ok === true
        const ok = beginsIdle && costOk && backToIdle && noSpend && channelsOk
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ beginsIdle, costOk, cost, backToIdle, noSpend, jobs: jobs.length, spentAfter, channelsOk })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] video-ui:', r)
    check('video-ui', r)
  }
  if (process.env.SHOT_CANVAS_I2I === '1') {
    // i2i 连线 + 血统边自测：出图 → 连线参考图 → 再出图（约 2 张图成本）
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const toolbar = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        const nodesByTitle = (t) => [...document.querySelectorAll('.ivc-node')].filter(n => (n.querySelector('.ivc-node-title')?.textContent || '').includes(t))
        const setText = (ta, v) => {
          const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          s.call(ta, v)
          ta.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const taIn = (n) => n.querySelector('.ivc-gen-prompt')
        const genIn = (n) => [...n.querySelectorAll('.ivc-gen button')].find(b => b.textContent.includes('生成'))
        toolbar('出图').click()
        await sleep(800)
        const genA = nodesByTitle('出图')[0]
        if (!genA) return 'ERR: 出图节点未创建'
        setText(taIn(genA), '一只柴犬坐在窗边，扁平插画，简洁背景')
        await sleep(300)
        genIn(genA).click()
        let t0 = Date.now()
        while (Date.now() - t0 < 90000) { await sleep(2000); if (nodesByTitle('图片').length > 0) break }
        if (!nodesByTitle('图片').length) return 'ERR: 底图未生成'
        toolbar('出图').click()
        await sleep(800)
        const gens = nodesByTitle('出图')
        const genC = gens[gens.length - 1]
        const imgB = nodesByTitle('图片')[0]
        const port = imgB.querySelector('.ivc-node-port')
        if (!port) return 'ERR: 图片节点无端口'
        const pr = port.getBoundingClientRect()
        const cr = genC.getBoundingClientRect()
        port.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: pr.left + pr.width / 2, clientY: pr.top + pr.height / 2, pointerId: 1, button: 0, buttons: 1 }))
        await sleep(200)
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cr.left + cr.width / 2, clientY: cr.top + 20, pointerId: 1, button: 0 }))
        await sleep(700)
        const refs = genC.querySelector('.ivc-gen-refs')
        if (!refs || !refs.textContent.includes('参考图')) return 'ERR: 连线未生效'
        setText(taIn(genC), '保持构图，改成水彩风格')
        await sleep(300)
        genIn(genC).click()
        t0 = Date.now()
        while (Date.now() - t0 < 120000) {
          await sleep(2000)
          if (nodesByTitle('图片').length >= 2) return 'OK:i2i_images=' + nodesByTitle('图片').length + ' in ' + Math.round((Date.now() - t0) / 1000) + 's'
        }
        return 'ERR: i2i 未产出新图'
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-i2i:', r)
    check('canvas-i2i', r)
  }
  if (process.env.SHOT_P0_PROMPT === '1') {
    // 提示词质量层 P0 端到端：组装 → 审计（含编造负例）→ z-image-turbo 真实出图（¥0.1）
    const brief = '新中式茶馆春季招募海报，可以加点暖色，要醒目点'
    const assembled = buildImagePrompt(brief, {
      size: '1024x1024',
      medium: '平面设计海报',
      palette: { main: '茶汤琥珀', accent: '宣纸米白', highlight: '金色描边' },
      layout: '信息阶梯',
      onImageText: ['春水煎茶', '招募茶艺师']
    })
    const audit = auditPlannedPrompt(assembled, brief, { needsText: true })
    // 负例（零成本）：Painter A/B 实测里模型编造的那段
    const badDraft = '隐山·茶事 春季招聘 联系电话 010-8888-6666 邮箱 hr@yinshan.com 地址 杭州西湖区龙井路 18 号 五险一金 月薪 8000 元'
    const badAudit = auditPlannedPrompt(badDraft, brief)
    const noFalsePositive = audit.findings.fabrications.length === 0 && audit.findings.missingPhrases.length === 0
    const detectsFabrication = badAudit.findings.fabrications.length >= 4
    const gen = await w.webContents.executeJavaScript(
      `window.api.generate({
        prompt: ${JSON.stringify(assembled)},
        model: 'z-image-turbo', provider: 'bailian', w: 1024, h: 1024
      }).then(x => 'OK:' + x.file).catch(e => 'ERR:' + e.message)`
    )
    const ok = noFalsePositive && detectsFabrication && String(gen).startsWith('OK:')
    const summary = JSON.stringify({
      noFalsePositive,
      detectsFabrication,
      fabricationKinds: badAudit.findings.fabrications.map((f) => f.kind),
      promptLen: assembled.length,
      gen
    })
    console.log('[shot] p0-prompt:', (ok ? 'OK:' : 'ERR:') + summary)
    check('p0-prompt', (ok ? 'OK:' : 'ERR:') + summary)
  }
  if (process.env.SHOT_PLAN_CHAT === '1') {
    // C1 对话面板：落消息 + drafting 即时返回 + 重启可恢复（IndexedDB）+ 输入不阻塞画布 + 迁移断言仍在跑
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1200)
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        const chatBtn = byText('对话')
        if (!chatBtn) return 'ERR: 未找到对话按钮（toolbar=' + [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].map(b => b.textContent).join('/') + ' | menu=' + document.querySelectorAll('.ant-menu-item').length + '）'
        // 先建一个画布节点：后面要断言"发送后画布不被阻塞（可拖动）"
        byText('文本').click()
        await sleep(500)
        chatBtn.click()
        await sleep(400)
        const panel = document.querySelector('[data-testid="chat-panel"]')
        if (!panel) return 'ERR: 面板未打开'
        const ta = panel.querySelector('textarea')
        if (!ta) return 'ERR: 面板无输入框'
        const setVal = (el, v) => {
          const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          s.call(el, v)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        setVal(ta, '做一条带货短视频，要有分镜和口播')
        await sleep(150)
        const sendBtn = [...panel.querySelectorAll('button')].find(b => b.textContent.includes('发送'))
        if (!sendBtn) return 'ERR: 未找到发送按钮（buttons=' + [...panel.querySelectorAll('button')].map(b => b.textContent).join('/') + '）'
        sendBtn.click()
        // 发送应立即返回（drafting），不等计划落定
        const t0 = Date.now()
        let lastCreate = null
        for (let i = 0; i < 20; i++) {
          await sleep(100)
          lastCreate = window.__canvasChat?.getLastCreateResult?.() ?? null
          if (lastCreate) break
        }
        const sendLatency = Date.now() - t0
        const drafting = lastCreate?.kind === 'plan' && lastCreate?.status === 'drafting'

        // 输入不阻塞画布：立刻拖一次节点，断言位移发生
        const node = document.querySelector('[data-node-id]')
        let dragOk = null
        if (node) {
          const header = node.querySelector('.ivc-node-header') || node
          const before = node.getBoundingClientRect()
          const r0 = header.getBoundingClientRect()
          header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r0.left + 30, clientY: r0.top + 8, pointerId: 9, button: 0, buttons: 1 }))
          for (let i = 1; i <= 4; i++) {
            window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r0.left + 30 + i * 10, clientY: r0.top + 8 + i * 4, pointerId: 9, buttons: 1 }))
            await sleep(30)
          }
          const mid = node.getBoundingClientRect()
          dragOk = Math.abs(mid.left - before.left) > 1
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r0.left + 70, clientY: r0.top + 24, pointerId: 9, button: 0 }))
        } else {
          dragOk = 'no-node'
        }

        // 持久化 + 迁移断言：读 messages / meta / plans（meta 写入是异步的，轮询最多 3s）
        let schema = null
        let db = null
        for (let i = 0; i < 30; i++) {
          await sleep(100)
          if (!db) {
            db = await new Promise((res, rej) => {
              const rq = indexedDB.open('miaodraw-canvas')
              rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error)
            })
          }
          const meta = await new Promise((res, rej) => {
            const tx = db.transaction('meta', 'readonly')
            const rq = tx.objectStore('meta').get('schema')
            rq.onsuccess = () => res(rq.result?.value ?? null); rq.onerror = () => rej(rq.error)
          })
          schema = meta
          if (schema?.version >= 5) break
        }
        const messages = await new Promise((res, rej) => {
          const tx = db.transaction('messages', 'readonly')
          const rq = tx.objectStore('messages').getAll()
          rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error)
        })
        const userRows = messages.filter(m => m.role === 'user')
        const plans = await window.api.planList()
        // #185 类回归守卫：getSnapshot 对未知 key 必须返回稳定引用（否则 useSyncExternalStore 无限重渲染→白屏）
        const stableSnapshot = window.__canvasChat.getMessages('__nope__') === window.__canvasChat.getMessages('__nope__')
        const ok = drafting && userRows.length >= 1 && dragOk === true && schema?.version >= 5 && schema?.assetsChecked > 0 && Array.isArray(plans) && plans.length >= 1 && stableSnapshot
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({
          drafting, sendLatency, userRows: userRows.length, dragOk, stableSnapshot,
          schemaVersion: schema?.version ?? null, assetsChecked: schema?.assetsChecked ?? null,
          plans: Array.isArray(plans) ? plans.length : null,
          stores: Array.from(db.objectStoreNames)
        })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] plan-chat:', r)
    check('plan-chat', r)
  }
  if (process.env.SHOT_PLAN_CHAT_FREEZE === '1') {
    // C5 冻结边界：已完成阶段标 frozen 且不可 patch；聊天改冻结区 → 先出范围确认卡，未确认不落库
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1200)
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        byText('对话').click()
        await sleep(400)
        const panel = document.querySelector('[data-testid="chat-panel"]')
        const ta = panel.querySelector('textarea')
        const setVal = (el, v) => {
          const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          s.call(el, v)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const send = async (msg) => {
          setVal(ta, msg)
          await sleep(120)
          ;[...panel.querySelectorAll('button')].find(b => b.textContent.includes('发送')).click()
          await sleep(600)
        }
        await send('做一条带货短视频，要有分镜和口播')
        let card = null
        for (let i = 0; i < 40; i++) { await sleep(200); card = document.querySelector('[data-plan-id]'); if (card) break }
        if (!card) return 'ERR: 计划卡未出现'
        const planId = card.getAttribute('data-plan-id')
        // 走完阶段 1（冻结它）
        let snap = await window.api.planAuthored(planId)
        let s1 = snap.stages[0]
        const a1 = await window.api.planAdvance({ planId, stageId: s1.id, action: 'confirm_plan', expectedRevision: s1.revision, actor: 'ui' })
        const a2 = await window.api.planAdvance({ planId, stageId: s1.id, action: 'execution_done', expectedRevision: a1.stage.revision, actor: 'auto' })
        await window.api.planAdvance({ planId, stageId: s1.id, action: 'confirm_result', expectedRevision: a2.stage.revision, actor: 'ui' })
        await sleep(500)
        // ① 卡片标 frozen + patch 被拒
        const stageEl = document.querySelector('[data-plan-id] [data-stage-id="' + s1.id + '"]')
        const frozenMark = stageEl?.getAttribute('data-frozen') === 'true'
        snap = await window.api.planAuthored(planId)
        const s1Now = snap.stages.find(s => s.id === s1.id)
        const patchRejected = (await window.api.planPatchStage({ planId, stageId: s1.id, patch: { goal: '偷改冻结阶段' }, expectedRevision: s1Now.revision }))
        const rejectedOk = patchRejected.ok === false && String(patchRejected.error || '').includes('冻结')
        // ② 聊天改冻结区 → 出现范围确认卡，且事件数不变（未落库）
        const eventsBefore = (await window.api.planEvents(planId)).length
        await send('把第一步改成横屏')
        await sleep(400)
        const confirmCard = panel.querySelector('[data-frozen-confirm="true"]')
        // 卡片必须给出两种处理方式（任务卡：新建计划 / 从当前阶段重排），否则用户无从选
        const confirmOptions = confirmCard ? [...confirmCard.querySelectorAll('button')].map((b) => (b.textContent || '').replace(/\\s+/g, '')) : []
        const hasOptions = confirmOptions.some((t) => t.includes('重排')) && confirmOptions.some((t) => t.includes('新建计划'))
        const eventsAfter = (await window.api.planEvents(planId)).length
        const noCommit = eventsAfter === eventsBefore
        const ok = frozenMark && rejectedOk && !!confirmCard && hasOptions && noCommit
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ frozenMark, rejectedOk, confirmCard: !!confirmCard, hasOptions, confirmOptions, noCommit, eventsBefore, eventsAfter })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] plan-chat-freeze:', r)
    check('plan-chat-freeze', r)
  }
  if (process.env.SHOT_PLAN_CHAT_RECOVER === '1') {
    // C6 空态/异常态/断线恢复：drafting 骨架 → stale 重试 → 丢一次事件后全量重拉（卡片/真相源/IndexedDB 三方一致）
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1200)
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        byText('对话').click()
        await sleep(400)
        const panel = document.querySelector('[data-testid="chat-panel"]')
        const ta = panel.querySelector('textarea')
        const setVal = (el, v) => {
          const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          s.call(el, v)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        setVal(ta, '做一条带货短视频，要有分镜和口播')
        await sleep(120)
        ;[...panel.querySelectorAll('button')].find(b => b.textContent.includes('发送')).click()
        let card = null
        for (let i = 0; i < 40; i++) { await sleep(200); card = document.querySelector('[data-plan-id]'); if (card) break }
        if (!card) return 'ERR: 计划卡未出现'
        const planId = card.getAttribute('data-plan-id')
        const cardEl = () => document.querySelector('[data-plan-id="' + planId + '"]')

        // ① 空态：drafting + 零物化（未到阈值）→ 骨架卡，且不得误标 stale
        const i1 = await window.api.planDebugInterrupt({ planId, ageMs: 0 })
        if (!i1?.ok) return 'ERR: 构造空态失败 ' + JSON.stringify(i1)
        await sleep(600)
        const skeleton = !!cardEl()?.querySelector('[data-skeleton="true"]')
        const staleWhenFresh = cardEl()?.getAttribute('data-stale') === 'true'

        // ② 异常态：同状态但 120s 无进展 → stale + 重试入口；点重试必须能重新推进
        const i2 = await window.api.planDebugInterrupt({ planId, ageMs: 120000 })
        if (!i2?.ok) return 'ERR: 构造中断失败 ' + JSON.stringify(i2)
        await sleep(600)
        const stale = cardEl()?.getAttribute('data-stale') === 'true'
        const retryBtn = cardEl()?.querySelector('[data-stale-retry="true"]')
        if (retryBtn) retryBtn.click()
        await sleep(1000)
        const staleAfterRetry = cardEl()?.getAttribute('data-stale') === 'true'
        const stagesAfterRetry = cardEl() ? cardEl().querySelectorAll('[data-stage-id]').length : 0
        const retryWorked = staleAfterRetry === false && stagesAfterRetry >= 1

        // ③ 断线恢复：丢一次事件 → 下一次 revision 跳变 → 全量重拉，卡片追平真相源与 IndexedDB
        const refreshesBefore = window.__planRecover.stats(planId).refreshes
        window.__planRecover.dropNext(planId)
        let snap = await window.api.planAuthored(planId)
        const s1 = snap.stages[0]
        await window.api.planAdvance({ planId, stageId: s1.id, action: 'confirm_plan', expectedRevision: s1.revision, actor: 'ui' }) // 这次推送被丢
        await sleep(300)
        const droppedCount = window.__planRecover.stats(planId).dropped
        const mid = await window.api.planAuthored(planId)
        const a2 = await window.api.planAdvance({ planId, stageId: s1.id, action: 'execution_done', expectedRevision: mid.stages[0].revision, actor: 'ui' })
        await sleep(1200)
        const stats = window.__planRecover.stats(planId)
        const truth = await window.api.planAuthored(planId)
        const truthStatus = truth.stages.map(s => s.id + '=' + s.status).sort().join(',')
        const domStatus = [...cardEl().querySelectorAll('[data-stage-id]')].map(el => el.getAttribute('data-stage-id') + '=' + el.getAttribute('data-status')).sort().join(',')
        const db = await new Promise((res, rej) => {
          const rq = indexedDB.open('miaodraw-canvas')
          rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error)
        })
        const rows = await new Promise((res, rej) => {
          const tx = db.transaction('stages', 'readonly')
          const rq = tx.objectStore('stages').getAll()
          rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error)
        })
        const dbStatus = rows.filter(s => s.plan_id === planId).map(s => s.id + '=' + s.status).sort().join(',')
        const consistent = domStatus === truthStatus && dbStatus === truthStatus
        const recovered = stats.refreshes > refreshesBefore
        const ok = skeleton && !staleWhenFresh && stale && retryWorked && droppedCount === 1 && recovered && consistent
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ skeleton, staleWhenFresh, stale, retryWorked, stagesAfterRetry, droppedCount, refreshesBefore, refreshes: stats.refreshes, reasons: stats.reasons, recovered, consistent, domStatus, truthStatus, dbStatus, advanced: a2?.ok === true })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] plan-chat-recover:', r)
    check('plan-chat-recover', r)
  }
  if (process.env.SHOT_PLAN_CHAT_AUTO === '1') {
    // C4 自动推进：开启后无需 confirm_plan 即过闸门（actor=auto）；blocked → 自动置 false 并有提示
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1200)
        const created = await window.api.planCreate({ prompt: '做一条带货短视频，要有分镜和口播', canvasContext: { videoReady: true } })
        const planId = created.planId
        let snap = null
        for (let i = 0; i < 30; i++) { await sleep(150); snap = await window.api.planAuthored(planId); if (snap?.stages?.length) break }
        if (!snap?.stages?.length) return 'ERR: 首阶段未物化'
        // 开启自动推进：阶段 1 应自动过 plan_review（actor=auto）
        const on = await window.api.planSetAutoAdvance({ planId, enabled: true, expectedRevision: snap.plan.revision })
        await sleep(500)
        snap = await window.api.planAuthored(planId)
        const s1 = snap.stages[0]
        const autoConfirmed = s1.status === 'doing' || s1.status === 'waiting_user'
        const autoEvents = (await window.api.planEvents(planId)).filter(e => e.actor === 'auto')
        const planFlag = (await window.api.planAuthored(planId)).plan.auto_advance === true
        // 执行器代跑：execution_done → 自动过 result_review → done
        const d = await window.api.planAdvance({ planId, stageId: s1.id, action: 'execution_done', expectedRevision: s1.revision, actor: 'auto' })
        await sleep(600)
        snap = await window.api.planAuthored(planId)
        const s1Done = snap.stages.find(s => s.id === s1.id)?.status === 'done'
        const autoEvents2 = (await window.api.planEvents(planId)).filter(e => e.actor === 'auto')
        const autoGates = autoEvents2.filter(e => String(e.event).includes('confirm_')).length

        // blocked：新计划 → 开启自动 → 把阶段置 blocked → 驱动一次 → 应自动转手动
        const created2 = await window.api.planCreate({ prompt: '再来一条短视频', canvasContext: { videoReady: true } })
        const pid2 = created2.planId
        let s2 = null
        for (let i = 0; i < 30; i++) { await sleep(150); const x = await window.api.planAuthored(pid2); s2 = x.stages?.[0] ?? null; if (s2) break }
        if (!s2) return 'ERR: 第二个计划首阶段未物化'
        await window.api.planSetAutoAdvance({ planId: pid2, enabled: true, expectedRevision: (await window.api.planAuthored(pid2)).plan.revision })
        await sleep(300)
        const cur = (await window.api.planAuthored(pid2)).stages[0]
        await window.api.planAdvance({ planId: pid2, stageId: cur.id, action: 'block', expectedRevision: cur.revision, actor: 'auto' })
        await sleep(300)
        // 触发一次机器（切换开关即会 drive）
        await window.api.planSetAutoAdvance({ planId: pid2, enabled: true, expectedRevision: (await window.api.planAuthored(pid2)).plan.revision })
        await sleep(500)
        const snap2 = await window.api.planAuthored(pid2)
        const blockedOff = snap2.plan.auto_advance === false
        const blockEvent = (await window.api.planEvents(pid2)).some(e => e.event === 'auto_advance_off_blocked')

        const ok = on.ok === true && planFlag && autoConfirmed && autoEvents.length >= 1 && s1Done && autoGates >= 2 && blockedOff && blockEvent
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({
          flagOn: planFlag, autoConfirmed, s1Done, autoGates, blockedOff, blockEvent,
          stages1: snap.stages.map(s => s.status)
        })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] plan-chat-auto:', r)
    check('plan-chat-auto', r)
  }
  if (process.env.SHOT_PLAN_CHAT_REVIEW === '1') {
    // C3 闸门审阅卡：渲染 prompt/检查项；行内编辑走 patchStage（revision+1）；过期 revision → data-conflict 且草稿保留
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1200)
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        byText('对话').click()
        await sleep(400)
        const panel = document.querySelector('[data-testid="chat-panel"]')
        const ta = panel.querySelector('textarea')
        const setVal = (el, v) => {
          const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          s.call(el, v)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        setVal(ta, '做一条带货短视频，要有分镜和口播')
        await sleep(150)
        ;[...panel.querySelectorAll('button')].find(b => b.textContent.includes('发送')).click()
        let card = null
        for (let i = 0; i < 40; i++) { await sleep(200); card = document.querySelector('[data-plan-id]'); if (card) break }
        if (!card) return 'ERR: 计划卡未出现'
        const planId = card.getAttribute('data-plan-id')
        // 打开审阅卡（点标题展开）
        let review = null
        for (let i = 0; i < 30; i++) {
          await sleep(200)
          review = panel.querySelector('[data-review-stage]')
          if (review) break
        }
        if (!review) return 'ERR: 审阅卡未渲染'
        review.querySelector('.ivc-reviewcard-head').click()
        await sleep(300)
        const promptArea = review.querySelector('textarea')
        const hasPrompt = !!promptArea && (promptArea.value || '').length > 0
        const checksText = (review.querySelector('.ivc-reviewcard-checks')?.textContent || '').length > 0
        const snap0 = await window.api.planAuthored(planId)
        const rev0 = snap0.stages[0].revision

        // 行内编辑 → 保存
        setVal(promptArea, '改好的提示词：简洁背景，商品居中，柔光')
        await sleep(150)
        ;[...review.querySelectorAll('button')].find(b => b.textContent.includes('保存提示词')).click()
        await sleep(600)
        const snap1 = await window.api.planAuthored(planId)
        const editedOk = snap1.stages[0].work_items.some(w => String(w.prompt).includes('改好的提示词')) && snap1.stages[0].revision === rev0 + 1

        // 冲突：先在背后用当前 revision 成功推进一次（卡片仍持旧 revision，且不会被通知到 —— 事件会刷新卡片，
        // 因此这里直接改 stage 快照之外的路径：用 patchGoal 推进 revision，然后立刻让卡片保存）
        const behind = await window.api.planPatchStage({ planId, stageId: snap1.stages[0].id, patch: { goal: '后台改一次' }, expectedRevision: snap1.stages[0].revision })
        await sleep(150)
        setVal(promptArea, '冲突期间编辑的草稿不应丢')
        await sleep(150)
        ;[...review.querySelectorAll('button')].find(b => b.textContent.includes('保存提示词')).click()
        await sleep(800)
        const conflictFlag = review.getAttribute('data-conflict') === 'true'
        const draftKept = (review.querySelector('textarea')?.value || '').includes('草稿不应丢')
        const ok = hasPrompt && checksText && editedOk && behind.ok === true && conflictFlag && draftKept
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ hasPrompt, checksText, editedOk, behindOk: behind.ok, conflictFlag, draftKept, rev0, rev1: snap1.stages[0].revision })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] plan-chat-review:', r)
    check('plan-chat-review', r)
  }
  if (process.env.SHOT_PLAN_CHAT_GATE === '1') {
    // C2 双向等价确认：卡片按钮(actor=ui) 与 聊天消息(actor=chat) 走同一状态机；
    // 镜像消息按 source_message_id 去重（先判重再写事件 → 无幽灵记录）
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1200)
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        byText('对话').click()
        await sleep(400)
        const panel = document.querySelector('[data-testid="chat-panel"]')
        const ta = panel.querySelector('textarea')
        const setVal = (el, v) => {
          const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          s.call(el, v)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        setVal(ta, '做一条带货短视频，要有分镜和口播')
        await sleep(150)
        ;[...panel.querySelectorAll('button')].find(b => b.textContent.includes('发送')).click()

        // 等计划卡出现（plan:changed 自动落卡）
        let card = null
        for (let i = 0; i < 40; i++) {
          await sleep(200)
          card = document.querySelector('[data-plan-id]')
          if (card) break
        }
        if (!card) return 'ERR: 计划卡未出现'
        const planId = card.getAttribute('data-plan-id')

        // —— 路径 A：卡片按钮走完整序列（actor=ui）——
        let btn = null
        for (let i = 0; i < 30; i++) {
          await sleep(200)
          btn = [...card.querySelectorAll('button')].find(b => b.textContent.includes('确认计划'))
          if (btn) break
        }
        if (!btn) return 'ERR: 卡片未出现确认按钮'
        btn.click()
        await sleep(500)
        btn.click() // 重复点击：镜像去重，不得产生第二条事件
        await sleep(500)
        let snap = await window.api.planAuthored(planId)
        const s1Doing = snap.stages.find(s => s.order === 1)?.status === 'doing'
        let s1 = snap.stages.find(s => s.order === 1)
        const d1 = await window.api.planAdvance({ planId, stageId: s1.id, action: 'execution_done', expectedRevision: s1.revision, actor: 'auto' })
        await sleep(500)
        // 卡片此时应出现「通过」按钮（result_review）
        let passBtn = null
        for (let i = 0; i < 20; i++) {
          await sleep(200)
          passBtn = [...document.querySelectorAll('[data-plan-id] button')].find(b => (b.textContent || '').replace(/\\s+/g, '') === '通过')
          if (passBtn) break
        }
        if (!passBtn) {
          const cards = [...document.querySelectorAll('[data-plan-id]')]
          return 'ERR: 卡片未出现通过按钮（cards=' + cards.length + ' stages=' + JSON.stringify((await window.api.planAuthored(planId)).stages.map(s => s.status + '/' + s.waiting_reason)) + ' buttons=' + cards.map(c => [...c.querySelectorAll('button')].map(b => b.textContent.trim()).join('|')).join(' ; ') + '）'
        }
        passBtn.click()
        await sleep(600)
        snap = await window.api.planAuthored(planId)
        const s1Done = snap.stages.find(s => s.order === 1)?.status === 'done'

        // —— 路径 B：聊天消息走完整序列（actor=chat）——
        await window.api.planAuthorStage({ planId })
        await sleep(500)
        const sendChat = async (msg) => {
          setVal(ta, msg)
          await sleep(120)
          ;[...panel.querySelectorAll('button')].find(b => b.textContent.includes('发送')).click()
          await sleep(500)
        }
        await sendChat('确认')
        snap = await window.api.planAuthored(planId)
        let s2 = snap.stages.find(s => s.order === 2)
        const s2Doing = s2?.status === 'doing'
        const d2 = await window.api.planAdvance({ planId, stageId: s2.id, action: 'execution_done', expectedRevision: s2.revision, actor: 'auto' })
        await sleep(300)
        await sendChat('确认')
        await sleep(400)
        snap = await window.api.planAuthored(planId)
        const s2Done = snap.stages.find(s => s.order === 2)?.status === 'done'

        const events = await window.api.planEvents(planId)
        const uiEvents = events.filter(e => e.actor === 'ui' && String(e.event).startsWith('advance:'))
        const chatEvents = events.filter(e => e.actor === 'chat' && String(e.event).startsWith('advance:'))
        const mirrorMsgs = window.__canvasChat.getMessages(planId).filter(m => m.source_message_id && m.source_message_id.startsWith('mirror:'))
        const mirrorIds = mirrorMsgs.map(m => m.source_message_id)
        const perMirror = {}
        for (const id of mirrorIds) perMirror[id] = (perMirror[id] || 0) + 1
        const mirrorUnique = Object.values(perMirror).every(v => v === 1)
        // 幽灵记录：卡片「确认计划」按钮点了两次 → 同 (stage1, confirm_plan) 只能 1 条镜像消息 + 1 条事件
        const s1PlanMirror = mirrorIds.filter(id => id.includes(s1.id) && id.endsWith(':confirm_plan')).length
        const s1PlanEvents = events.filter(e => e.event === 'advance:confirm_plan' && e.stage_id === s1.id).length
        const ghostFree = s1PlanMirror === 1 && s1PlanEvents === 1
        const bothEquivalent = s1Done && s2Done && s1Doing && s2Doing
        const ok = bothEquivalent && uiEvents.length >= 2 && chatEvents.length >= 2 && mirrorUnique && ghostFree
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({
          bothEquivalent, s1Done, s2Done, s1Doing, s2Doing,
          uiEvents: uiEvents.length, chatEvents: chatEvents.length,
          mirrorMessages: mirrorMsgs.length, mirrorUnique, ghostFree
        })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] plan-chat-gate:', r)
    check('plan-chat-gate', r)
  }
  if (process.env.SHOT_PLAN_CHAT_RERENDER === '1') {
    // C1 硬约束：滚动对话 + 收发各 5 条时，画布节点渲染增量必须为 0
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1200)
        // 建两个画布节点，确保有节点可被重渲染
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        byText('文本').click(); await sleep(300)
        byText('图片').click(); await sleep(300)
        byText('对话').click(); await sleep(400)
        const panel = document.querySelector('[data-testid="chat-panel"]')
        if (!panel) return 'ERR: 面板未打开'
        window.__canvasNodeRenders = 0
        await sleep(200)
        const before = window.__canvasNodeRenders
        // 先建计划（首条消息），此后只做聊天收发
        const ta = panel.querySelector('textarea')
        const setVal = (el, v) => {
          const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          s.call(el, v)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        setVal(ta, '做一条带货短视频')
        ;[...panel.querySelectorAll('button')].find(b => b.textContent.includes('发送')).click()
        await sleep(1500) // 等首阶段事件（会带来一轮计划刷新，先计入基线之后重取）
        const baseline = window.__canvasNodeRenders
        // 滚动对话 500px
        const list = panel.querySelector('[data-testid="chat-list"]')
        list.scrollTop = 500
        await sleep(200)
        // 收发各 5 条（走 store 注入，模拟消息到达/发送）
        for (let i = 1; i <= 5; i++) {
          window.__canvasChatInject?.('user', '用户消息 ' + i)
          await sleep(60)
          window.__canvasChatInject?.('agent', '助手回复 ' + i)
          await sleep(60)
        }
        await sleep(400)
        const after = window.__canvasNodeRenders
        const delta = after - baseline
        const ok = delta === 0
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ baseline, after, delta, nodes: document.querySelectorAll('[data-node-id]').length })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] plan-chat-rerender:', r)
    check('plan-chat-rerender', r)
  }
  if (process.env.SHOT_PLAN_B === '1') {
    // B 批增量协议端到端：replan 增量 + 冻结前缀 + 幂等重放 + CAS 冲突 + 原子性 + 审计落盘 + cancel
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1200)
        const created = await window.api.planCreate({ prompt: '做一条带货短视频，要有分镜和口播', canvasContext: { videoReady: true } })
        if (created.kind !== 'plan') return 'ERR: 未建成计划'
        const planId = created.planId
        let snap = null
        for (let i = 0; i < 20; i++) { await sleep(150); snap = await window.api.planAuthored(planId); if (snap?.stages?.length) break }
        if (!snap?.stages?.length) return 'ERR: 首阶段未物化'
        // 走完阶段 1（冻结前缀）
        let s1 = snap.stages[0]
        let a1 = await window.api.planAdvance({ planId, stageId: s1.id, action: 'confirm_plan', expectedRevision: s1.revision })
        let a2 = await window.api.planAdvance({ planId, stageId: s1.id, action: 'execution_done', expectedRevision: a1.stage.revision })
        let a3 = await window.api.planAdvance({ planId, stageId: s1.id, action: 'confirm_result', expectedRevision: a2.stage.revision, actor: 'chat' })
        const done1 = a3.stage.status === 'done'
        // author 阶段 2
        await window.api.planAuthorStage({ planId })
        await sleep(200)
        snap = await window.api.planAuthored(planId)
        const s2 = snap.stages.find(s => s.order === 2)
        if (!s2) return 'ERR: 阶段 2 未物化'
        const revBefore = snap.plan.revision
        const s1RevBefore = snap.stages.find(s => s.id === s1.id).revision
        // 增量：改阶段 2 + 追加 outline（带冻结前缀与溯源消息）
        const increment = await window.api.planReplan({
          planId, requestId: 'req-probe-1', preserveThroughStageId: s1.id, expectedRevision: revBefore,
          actor: 'chat', sourceMessageId: 'msg_probe_1',
          ops: [
            { kind: 'revise_stage', stage_id: s2.id, patch: { goal: '按新需求重写画面方向' } },
            { kind: 'insert_stage_outline', entry: { id: planId + '_s9', order: 9, name: '加映花絮' } }
          ]
        })
        const incOk = increment.ok === true && increment.frozen_through === s1.id && increment.revision === revBefore + 1
        const frozenIntact = (await window.api.planAuthored(planId)).stages.find(s => s.id === s1.id).revision === s1RevBefore

        // 幂等重放
        const replay = await window.api.planReplan({
          planId, requestId: 'req-probe-1', preserveThroughStageId: s1.id, expectedRevision: revBefore,
          actor: 'chat', sourceMessageId: 'msg_probe_1',
          ops: [
            { kind: 'revise_stage', stage_id: s2.id, patch: { goal: '按新需求重写画面方向' } },
            { kind: 'insert_stage_outline', entry: { id: planId + '_s9', order: 9, name: '加映花絮' } }
          ]
        })
        const replayOk = replay.ok === true && replay.replayed === true
        const revAfterReplay = (await window.api.planAuthored(planId)).plan.revision

        // CAS 冲突（用过期的 revision）
        const cas = await window.api.planReplan({ planId, requestId: 'req-probe-cas', expectedRevision: revBefore, ops: [] })
        const casOk = cas.ok === false && cas.conflict?.code === 'PLAN_REVISION_CONFLICT' && cas.conflict.current_state.actual_revision >= revBefore + 1

        // 原子性：合法 + 非法 op 混合 → 全不生效
        const beforeAtomic = JSON.stringify(await window.api.planAuthored(planId))
        const atomic = await window.api.planReplan({
          planId, requestId: 'req-probe-atomic',
          ops: [
            { kind: 'revise_stage', stage_id: s2.id, patch: { name: '本次不应生效' } },
            { kind: 'revise_stage', stage_id: 'not-exist', patch: { name: 'x' } }
          ]
        })
        const atomicOk = atomic.ok === false && JSON.stringify(await window.api.planAuthored(planId)) === beforeAtomic

        // 审计事件（IPC + IndexedDB）
        const events = await window.api.planEvents(planId)
        const auditOk = Array.isArray(events) && events.some(e => e.event === 'replan' && e.request_id === 'req-probe-1' && e.source_message_id === 'msg_probe_1')
        await sleep(300)
        const db = await new Promise((res, rej) => {
          const rq = indexedDB.open('miaodraw-canvas')
          rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error)
        })
        const persisted = await new Promise((res, rej) => {
          const tx = db.transaction('plan_events', 'readonly')
          const rq = tx.objectStore('plan_events').count()
          rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error)
        })

        // cancel
        const cancel = await window.api.planCancel(planId)
        const cancelled = cancel.ok === true && (await window.api.planAuthored(planId)).plan.status === 'cancelled'

        const ok = done1 && incOk && frozenIntact && replayOk && casOk && atomicOk && auditOk && persisted >= 1 && cancelled
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({
          done1, incOk, frozenIntact, replayOk, revAfterReplay, casOk, atomicOk, auditOk,
          persistedEvents: persisted, cancelled, stores: Array.from(db.objectStoreNames)
        })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] plan-b:', r)
    check('plan-b', r)
  }
  if (process.env.SHOT_PLAN_O1 === '1') {
    // 编排 O1 端到端：plan:create 立即返回 drafting → 事件推进首阶段 → 状态机走完 → IndexedDB 落盘
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1200)
        const created = await window.api.planCreate({
          prompt: '帮我做一条带货短视频，要有分镜和口播',
          canvasContext: { videoReady: true }
        })
        if (created.kind !== 'plan') return 'ERR: 未建成计划 ' + JSON.stringify(created)
        const immediateDrafting = created.status === 'drafting'
        const planId = created.planId
        let snap = null
        for (let i = 0; i < 20; i++) {
          await sleep(150)
          snap = await window.api.planAuthored(planId)
          if (snap && snap.stages && snap.stages.length > 0) break
        }
        if (!snap || !snap.stages || snap.stages.length === 0) return 'ERR: 首阶段未物化'
        const first = snap.stages[0]
        const gate = first.status === 'waiting_user' && first.waiting_reason === 'plan_review'
        const outline = snap.plan.stage_outline.length

        const a1 = await window.api.planAdvance({ planId, stageId: first.id, action: 'confirm_plan', expectedRevision: first.revision })
        const a2 = await window.api.planAdvance({ planId, stageId: first.id, action: 'execution_done', expectedRevision: a1.stage.revision })
        const a3 = await window.api.planAdvance({ planId, stageId: first.id, action: 'confirm_result', expectedRevision: a2.stage.revision })
        const chain = a1.stage.status === 'doing' && a2.stage.waiting_reason === 'result_review' && a3.stage.status === 'done'

        const stale = await window.api.planAdvance({ planId, stageId: first.id, action: 'retry', expectedRevision: first.revision })
        const conflict = stale.ok === false && stale.conflict === true

        await sleep(400)
        const db = await new Promise((res, rej) => {
          const rq = indexedDB.open('miaodraw-canvas')
          rq.onsuccess = () => res(rq.result)
          rq.onerror = () => rej(rq.error)
        })
        const count = (store) => new Promise((res, rej) => {
          const tx = db.transaction(store, 'readonly')
          const rq = tx.objectStore(store).count()
          rq.onsuccess = () => res(rq.result)
          rq.onerror = () => rej(rq.error)
        })
        const plans = await count('plans')
        const stages = await count('stages')
        const stores = Array.from(db.objectStoreNames)
        const ok = immediateDrafting && gate && chain && conflict && plans >= 1 && stages >= 1
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ immediateDrafting, outline, gate, chain, conflict, plans, stages, stores })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] plan-o1:', r)
    check('plan-o1', r)
  }
  if (process.env.SHOT_CANVAS_CONNECT === '1') {
    // 连线反馈可断言探针（不做截图验收）：橡皮筋在画布层 + 起点=真实端口中心(±1px) + 目标高亮
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1500)
        const toolbar = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        const nodesByTitle = (t) => [...document.querySelectorAll('.ivc-node')].filter(n => (n.querySelector('.ivc-node-title')?.textContent || '').includes(t))
        toolbar('图片').click(); await sleep(600)
        toolbar('出图').click(); await sleep(600)
        // 画布可能已有历史节点：必须取「最新创建」的一对，否则悬停点可能被别的节点盖住，
        // 高亮断言会随机失败（探针多次运行后必然踩到）
        const imgs = nodesByTitle('图片')
        const gens = nodesByTitle('出图')
        const img = imgs[imgs.length - 1]
        const gen = gens[gens.length - 1]
        if (!img || !gen) return 'ERR: 节点未创建'
        const port = img.querySelector('.ivc-node-port')
        if (!port) return 'ERR: 图片节点无端口'
        const pr = port.getBoundingClientRect()
        const portCx = pr.left + pr.width / 2
        const portCy = pr.top + pr.height / 2
        port.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: portCx, clientY: portCy, pointerId: 3, button: 0, buttons: 1 }))
        await sleep(120)
        const gr = gen.getBoundingClientRect()
        // 连线命中已改为「目标左侧中部锚点的圆形热区」(44px 屏幕半径)：
        // 拖到节点身上不再成连，所以探针也必须瞄锚点，否则测的是旧语义。
        const targetX = gr.left + 2
        const targetY = gr.top + gr.height / 2
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: targetX, clientY: targetY, pointerId: 3, buttons: 1 }))
        await sleep(220)
        const path = document.querySelector('[data-pending-line]')
        if (!path) return 'ERR: 橡皮筋未渲染'
        const inCanvasLayer = !!path.closest('.ivc-root') && !path.closest('[data-node-id]')
        const highlighted = gen.className.includes('ivc-node-drop')
        const d = path.getAttribute('d') || ''
        const m = d.match(/M\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)/)
        if (!m) return 'ERR: path d 解析失败: ' + d
        const world = document.querySelector('.ivc-world')
        const tm = (world.style.transform || '').match(/translate(?:3d)?\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px(?:,\\s*0px)?\\)\\s*scale\\(([\\d.]+)\\)/)
        const k = tm ? Number(tm[3]) : 1
        const vx = tm ? Number(tm[1]) : 0
        const vy = tm ? Number(tm[2]) : 0
        const rootRect = document.querySelector('.ivc-root').getBoundingClientRect()
        // 连线层已在 world 坐标系内（<g> 负责回原点），path 的 d 直接是世界坐标，无需 OFF 偏移
        const startX = rootRect.left + vx + Number(m[1]) * k
        const startY = rootRect.top + vy + Number(m[2]) * k
        const dx = Math.abs(startX - portCx)
        const dy = Math.abs(startY - portCy)
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: targetX, clientY: targetY, pointerId: 3, button: 0 }))
        await sleep(300)
        const ok = inCanvasLayer && highlighted && dx <= 1 && dy <= 1
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ inCanvasLayer, highlighted, startDx: +dx.toFixed(2), startDy: +dy.toFixed(2), scale: k })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-connect:', r)
    check('canvas-connect', r)
  }
  if (process.env.SHOT_CANVAS_QUICK === '1') {
    // 快速建图探针：单击连线端口 → 就地弹「新建」菜单 → 选「出图」→ 自动建节点并自动连线
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1500)
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        byText('图片').click(); await sleep(700)
        const imgs = [...document.querySelectorAll('.ivc-node')].filter(n => (n.querySelector('.ivc-node-title')?.textContent || '').includes('图片'))
        const img = imgs[imgs.length - 1]
        if (!img) return 'ERR: 图片节点未创建'
        const port = img.querySelector('.ivc-node-port')
        if (!port) return 'ERR: 图片节点无端口'
        const pr = port.getBoundingClientRect()
        const cx = pr.left + pr.width / 2
        const cy = pr.top + pr.height / 2
        const nodesBefore = document.querySelectorAll('[data-node-id]').length
        const connsBefore = document.querySelectorAll('.ivc-connections > g > [data-connection-id]').length
        port.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, pointerId: 11, button: 0, buttons: 1 }))
        await sleep(80)
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx, clientY: cy, pointerId: 11, button: 0 }))
        await sleep(300)
        const menuEl = document.querySelector('[data-quick-create="true"]')
        if (!menuEl) return 'ERR: 端口单击未弹出新建菜单'
        const itemCount = menuEl.querySelectorAll('[data-create-type]').length
        const genBtn = [...menuEl.querySelectorAll('[data-create-type]')].find(b => b.getAttribute('data-create-type') === 'generate')
        if (!genBtn) return 'ERR: 快速新建菜单缺少出图项'
        genBtn.click()
        await sleep(500)
        const nodesAfter = document.querySelectorAll('[data-node-id]').length
        const connsAfter = document.querySelectorAll('.ivc-connections > g > [data-connection-id]').length
        const closed = !document.querySelector('[data-quick-create="true"]')
        const ok = nodesAfter === nodesBefore + 1 && connsAfter === connsBefore + 1 && closed && itemCount >= 7
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ nodesBefore, nodesAfter, connsBefore, connsAfter, itemCount, closed })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-quick:', r)
    check('canvas-quick', r)
  }
  if (process.env.SHOT_CANVAS_ACTIONS === '1') {
    // 节点浮动操作条探针：单选时出现，复制副本 +1、删除回到原数量
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1500)
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        const count = () => document.querySelectorAll('[data-node-id]').length
        const before = count()
        byText('文本').click()
        await sleep(500)
        const afterCreate = count()
        const bar = document.querySelector('[data-node-actions="true"]')
        if (!bar) return 'ERR: 单选未出现浮动操作条'
        const dup = bar.querySelector('[data-node-action="duplicate"]')
        const del = bar.querySelector('[data-node-action="delete"]')
        if (!dup || !del) return 'ERR: 操作条缺少按钮'
        dup.click()
        await sleep(400)
        const afterDup = count()
        const barAfterDup = !!document.querySelector('[data-node-actions="true"]')
        del.click()
        await sleep(400)
        const afterDelete = count()
        const ok = afterCreate === before + 1 && afterDup === before + 2 && afterDelete === before + 1 && barAfterDup
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ before, afterCreate, afterDup, afterDelete, barAfterDup })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-actions:', r)
    check('canvas-actions', r)
  }
  if (process.env.SHOT_CANVAS_UPLOAD === '1') {
    // 画布上传落盘探针：canvas:importImage 写 userData/canvas-assets，返回可被 media://cvs 读回的短路径
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        const res = await window.api.canvasImportImage({ name: 'probe.png', data: bytes })
        if (!res || !res.ok) return 'ERR:' + JSON.stringify(res)
        const back = await window.api.imageRead(res.url)
        const ok = res.url.startsWith('media://local/cvs/') && back.byteLength === bytes.byteLength && back[1] === 0x50
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ url: res.url, bytes: back.byteLength })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-upload:', r)
    check('canvas-upload', r)
  }
  if (process.env.SHOT_CANVAS_MATERIAL === '1') {
    // 本机作品抽屉探针：打开 → 有卡片 → 点一张 → 画布多一个带 media:// 内容的图片节点
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        document.querySelectorAll('.ant-menu-item')[1]?.click()
        await sleep(1500)
        const count = () => document.querySelectorAll('[data-node-id]').length
        const before = count()
        const openBtn = document.querySelector('[data-material-open="true"]')
        if (!openBtn) return 'ERR: 缺少「作品」入口'
        openBtn.click()
        await sleep(1200)
        const cards = [...document.querySelectorAll('[data-material-item]')]
        if (!cards.length) return 'SKIP: 本机没有作品可插入'
        cards[0].click()
        await sleep(700)
        const after = count()
        const imgs = [...document.querySelectorAll('.ivc-node img.ivc-img')].map((el) => el.getAttribute('src') || '')
        const hasMedia = imgs.some((src) => src.startsWith('media://local/out/'))
        // AntD Drawer 关闭后 DOM 仍保留（只是不显示），因此判「是否还有 ant-drawer-open」
        const closed = !document.querySelector('.ant-drawer-open')
        const ok = after === before + 1 && hasMedia && closed
        return (ok ? 'OK:' : 'ERR:') + JSON.stringify({ before, after, cards: cards.length, hasMedia, closed })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-material:', r)
    check('canvas-material', r)
  }
  if (process.env.SHOT_CANVAS_PERSIST === '1') {
    // 画布持久化探针：建节点 → 手动落盘 → reload 渲染进程 → 校验节点/连线回来
    const setup = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        document.querySelectorAll('.ant-menu-item')[1]?.click()
        await sleep(1500)
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        byText('文本').click()
        await sleep(500)
        byText('图片').click()
        await sleep(500)
        const nodes = document.querySelectorAll('[data-node-id]').length
        const ok = window.__canvasDoc ? await window.__canvasDoc.save() : null
        await sleep(300)
        return JSON.stringify({ nodes, saved: ok })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-persist-setup:', setup)
    await new Promise<void>((resolve) => {
      w.webContents.once('did-finish-load', () => resolve())
      w.webContents.reload()
    })
    await new Promise((r) => setTimeout(r, 2500))
    const after = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        // 重载后新手引导可能再次弹出（探针 profile 每次重置），先跳过再进画布
        const skip = [...document.querySelectorAll('.ant-modal button')].find(x => (x.textContent || '').includes('跳过'))
        if (skip) { skip.click(); await sleep(400) }
        document.querySelectorAll('.ant-menu-item')[1]?.click()
        await sleep(2000)
        return JSON.stringify({
          nodes: document.querySelectorAll('[data-node-id]').length,
          conns: document.querySelectorAll('.ivc-connections > g > [data-connection-id]').length,
          restored: document.body.textContent.includes('已恢复画布文档') ? true : undefined
        })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-persist-after:', after)
    let parsedSetup: { nodes?: number } = {}
    let parsedAfter: { nodes?: number } = {}
    try {
      parsedSetup = JSON.parse(setup)
      parsedAfter = JSON.parse(after)
    } catch {
      // 交给下面的断言报错
    }
    const ok = (parsedSetup.nodes ?? 0) >= 2 && parsedAfter.nodes === parsedSetup.nodes
    check('canvas-persist', (ok ? 'OK:' : 'ERR:') + JSON.stringify({ before: parsedSetup.nodes, after: parsedAfter.nodes }))
  }
  if (process.env.SHOT_CANVAS_DRAG === '1') {
    // 拖拽手感探针：合成 pointerdown→pointermove×10→pointerup，测「拖动过程中是否有实时视觉反馈」
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        // 探针自足：先切到画布视图。否则画布容器 display:none 时节点 getBoundingClientRect 恒为 0，
        // 任何实现都会被测成「无位移」（基线那次 false 即由此放大，不能作为实现是否跟手的唯一判据）。
        const canvasMenu = document.querySelectorAll('.ant-menu-item')[1]
        if (canvasMenu) canvasMenu.click()
        await sleep(1500)
        byText('文本').click()
        await sleep(700)
        const node = document.querySelector('[data-node-id]')
        if (!node) return 'ERR: 节点未创建'
        const header = node.querySelector('.ivc-node-header') || node
        const before = node.getBoundingClientRect()
        const r0 = header.getBoundingClientRect()
        const cx = r0.left + 40, cy = r0.top + 10
        header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, pointerId: 7, button: 0, buttons: 1 }))
        await sleep(80)
        for (let i = 1; i <= 10; i++) {
          window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx + i * 12, clientY: cy + i * 6, pointerId: 7, buttons: 1 }))
          await sleep(30)
        }
        const mid = node.getBoundingClientRect()
        const during = (Math.abs(mid.left - before.left) > 1 || Math.abs(mid.top - before.top) > 1)
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx + 120, clientY: cy + 60, pointerId: 7, button: 0 }))
        await sleep(400)
        const after = node.getBoundingClientRect()
        return JSON.stringify({
          liveFeedbackWhileDragging: during,
          movedAfterRelease: (Math.abs(after.left - before.left) > 1 || Math.abs(after.top - before.top) > 1),
          dx: Math.round(after.left - before.left),
          dy: Math.round(after.top - before.top)
        })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-drag:', r)
  }
  if (process.env.SHOT_CANVAS_UNDO === '1') {
    // 撤销/重做探针：建节点 → 撤销（应回到建之前）→ 重做（应回到建之后）
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1500)
        const count = () => document.querySelectorAll('[data-node-id]').length
        const before = count()
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        byText('文本').click()
        await sleep(400)
        const afterAdd = count()
        await sleep(400) // 等历史防抖提交
        const undoBtn = document.querySelector('[data-undo="true"]')
        if (!undoBtn) return 'ERR: 未找到撤销按钮'
        undoBtn.click()
        await sleep(400)
        const afterUndo = count()
        const redoBtn = document.querySelector('[data-redo="true"]')
        if (!redoBtn) return 'ERR: 未找到重做按钮'
        redoBtn.click()
        await sleep(400)
        const afterRedo = count()
        return JSON.stringify({ before, afterAdd, afterUndo, afterRedo, ok: afterAdd === before + 1 && afterUndo === before && afterRedo === afterAdd })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-undo:', r)
    check('canvas-undo', r)
  }
  if (process.env.SHOT_CANVAS_CLIP === '1') {
    // 剪贴板探针：建节点 → Ctrl+C → Ctrl+V（应 +1）→ Ctrl+D 复制副本（再 +1）
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1500)
        const count = () => document.querySelectorAll('[data-node-id]').length
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        byText('文本').click()
        await sleep(400)
        const before = count()
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }))
        await sleep(500)
        const afterPaste = count()
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }))
        await sleep(500)
        const afterDup = count()
        return JSON.stringify({ before, afterPaste, afterDup, ok: afterPaste === before + 1 && afterDup === before + 2 })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-clip:', r)
    check('canvas-clip', r)
  }
  if (process.env.SHOT_CANVAS_MARQUEE === '1') {
    // 框选探针：建两个节点后在空白处拖出覆盖框，断言两个节点都被选中
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1500)
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        const beforeIds = new Set([...document.querySelectorAll('[data-node-id]')].map(n => n.getAttribute('data-node-id')))
        byText('文本').click()
        await sleep(150)
        byText('图片').click()
        await sleep(400)
        const rootEl = document.querySelector('.ivc-root')
        const root = rootEl.getBoundingClientRect()
        const nodes = [...document.querySelectorAll('[data-node-id]')].filter(n => !beforeIds.has(n.getAttribute('data-node-id')))
        if (nodes.length < 2) return JSON.stringify({ err: 'newNodes<2', n: nodes.length })
        const rects = nodes.slice(0, 2).map(n => n.getBoundingClientRect())
        const minL = Math.min(...rects.map(r => r.left)), minT = Math.min(...rects.map(r => r.top))
        const maxR = Math.max(...rects.map(r => r.right)), maxB = Math.max(...rects.map(r => r.bottom))
        const sx = Math.max(root.left + 4, minL - 40), sy = Math.max(root.top + 4, minT - 40)
        const ex = Math.min(root.right - 4, maxR + 40), ey = Math.min(root.bottom - 4, maxB + 40)
        rootEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: sx, clientY: sy, pointerId: 11, button: 0, buttons: 1 }))
        await sleep(60)
        for (let i = 1; i <= 8; i++) {
          window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: sx + (ex - sx) * i / 8, clientY: sy + (ey - sy) * i / 8, pointerId: 11, buttons: 1 }))
          await sleep(30)
        }
        const sawMarquee = !!document.querySelector('[data-marquee="true"]')
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ex, clientY: ey, pointerId: 11, button: 0 }))
        await sleep(300)
        const selected = document.querySelectorAll('.ivc-node-selected').length
        return JSON.stringify({ selected, sawMarquee, ok: selected >= 2 })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-marquee:', r)
    check('canvas-marquee', r)
  }
  if (process.env.SHOT_CANVAS_HELP === '1') {
    // 快捷键面板探针：按 ? 打开，断言弹层出现且列出关键快捷键
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1500)
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }))
        await sleep(500)
        const modal = [...document.querySelectorAll('.ant-modal')].find(m => m.textContent.includes('画布快捷键'))
        const text = modal ? modal.textContent : ''
        return JSON.stringify({
          open: !!modal,
          hasUndo: text.includes('Ctrl') && text.includes('撤销'),
          hasSnap: text.includes('Alt') && text.includes('吸附'),
          ok: !!modal && text.includes('撤销') && text.includes('吸附')
        })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-help:', r)
    check('canvas-help', r)
  }
  if (process.env.SHOT_CANVAS_CONNECT === '1') {
    // 连线探针：文本→出图应连通；音频→出图应被类型校验拒绝
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const menu = document.querySelectorAll('.ant-menu-item')[1]
        if (menu) menu.click()
        await sleep(1500)
        const byText = (t) => [...document.querySelectorAll('.ivc-toolbar button, .ivc-topbar button')].find(b => b.textContent.includes(t))
        const connCount = () => document.querySelectorAll('.ivc-connections > g > g').length
        const before = new Set([...document.querySelectorAll('[data-node-id]')].map(n => n.getAttribute('data-node-id')))
        byText('文本').click()
        await sleep(200)
        byText('出图').click()
        await sleep(400)
        const fresh = [...document.querySelectorAll('[data-node-id]')].filter(n => !before.has(n.getAttribute('data-node-id')))
        const base = connCount()
        const drag = (fromEl, toEl) => {
          const port = fromEl.querySelector('.ivc-node-port')
          if (!port) return false
          const pr = port.getBoundingClientRect()
          const tr = toEl.getBoundingClientRect()
          port.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: pr.left + pr.width / 2, clientY: pr.top + pr.height / 2, pointerId: 21, button: 0, buttons: 1 }))
          // 连线命中已改为目标左侧中部锚点的圆形热区；瞄节点中心不再成连（这是刻意的防误连）
          const tx = tr.left + 2, ty = tr.top + tr.height / 2
          window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: tx, clientY: ty, pointerId: 21, buttons: 1 }))
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: tx, clientY: ty, pointerId: 21, button: 0 }))
          return true
        }
        await sleep(100)
        const okDrag = fresh.length >= 2 ? drag(fresh[0], fresh[1]) : false
        await sleep(300)
        const afterValid = connCount()
        byText('音频').click()
        await sleep(300)
        const all = [...document.querySelectorAll('[data-node-id]')].filter(n => !before.has(n.getAttribute('data-node-id')))
        const audio = all[all.length - 1]
        if (audio) drag(audio, fresh[1])
        await sleep(300)
        const afterInvalid = connCount()
        return JSON.stringify({
          base, okDrag, afterValid, afterInvalid,
          validOk: afterValid === base + 1,
          invalidRejected: afterInvalid === afterValid,
          ok: afterValid === base + 1 && afterInvalid === afterValid
        })
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-connect-rules:', r)
    check('canvas-connect-rules', r)
  }
  if (process.env.SHOT_CANVAS_ASSETS === '1') {
    // 画布数据层自测（零成本）：直接读 IndexedDB，核对资产入库与血统边
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const openDb = () => new Promise((res, rej) => {
          const rq = indexedDB.open('miaodraw-canvas')
          rq.onsuccess = () => res(rq.result)
          rq.onerror = () => rej(rq.error)
        })
        try {
          const db = await openDb()
          const all = (store) => new Promise((res, rej) => {
            const tx = db.transaction(store, 'readonly')
            const rq = tx.objectStore(store).getAll()
            rq.onsuccess = () => res(rq.result)
            rq.onerror = () => rej(rq.error)
          })
          const assets = await all('assets')
          const deps = await all('asset_dependencies')
          const px = assets.filter(a => String(a.path || '').startsWith('pixelle/'))
          const meta = assets.filter(a => a.metadata && String(JSON.stringify(a.metadata)).includes('source'))
          const withQuick = assets.filter(a => a.quick_hash && String(a.quick_hash).length > 8)
          const byHash = {}
          for (const a of withQuick) byHash[a.quick_hash] = (byHash[a.quick_hash] || 0) + 1
          const dupHashes = Object.keys(byHash).filter(k => byHash[k] > 1)
          const dupDetail = dupHashes.slice(0, 3).map(k => ({
            hash: String(k).slice(0, 10),
            paths: withQuick.filter(a => a.quick_hash === k).map(a => a.path)
          }))
          const withFull = assets.filter(a => a.full_hash && String(a.full_hash).length > 8)
          return JSON.stringify({
            assets: assets.length,
            pixelle: px.length,
            lastPixelle: px.slice(-2).map(a => a.path),
            deps: deps.length,
            lastDeps: deps.slice(-2).map(d => ({ role: d.role, op: d.operation })),
            withMeta: meta.length,
            quickHash: withQuick.length,
            fullHash: withFull.length,
            dupHashGroups: dupHashes.length,
            dupDetail,
            statusMissing: assets.filter(a => a.status === 'missing').length
          })
        } catch (e) { return 'ERR:' + e.message }
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] canvas-assets:', r)
    check('canvas-assets', r)
  }
  if (process.env.SHOT_KEY === '1') {
    // 百炼密钥全链路自测：读取 → （已有则不动，避免覆盖真实密钥）→ 类型/掩码断言
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const out = {}
        try {
          const info = await window.api.bailianKeyGet()
          out.configured = info.configured
          out.plan = info.plan
          out.masked = info.configured ? info.masked.replace(/[^•]/g, '*') : ''
          const h = await window.api.health()
          out.hasKeyFlag = h.hasKey
        } catch (e) { out.err = e.message }
        return JSON.stringify(out)
      })()`
    )
    console.log('[shot] key:', r)
    check('key', r)
    await new Promise((r2) => setTimeout(r2, 500))
  }
  if (process.env.SHOT_SEG === '1') {
    const r = await w.webContents.executeJavaScript(
      `(async () => {
        const h = await window.api.history()
        if (!h.length) return 'ERR: no history'
        const src = h[0].url
        const t0 = Date.now()
        const m = await window.api.segmentMask(src, [{ x: 512, y: 512 }])
        window.__segMask = m.maskUrl
        return 'OK:' + m.width + 'x' + m.height + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'
      })().catch(e => 'ERR:' + e.message)`
    )
    console.log('[shot] seg:', r)
    check('seg', r)
    try {
      const maskUrl = await w.webContents.executeJavaScript(`window.__segMask`)
      if (maskUrl) fs.writeFileSync(path.join(APP_ROOT, 'seg-mask.png'), Buffer.from(maskUrl.split(',')[1], 'base64'))
    } catch {}
  }
  try {
    const img = await w.webContents.capturePage()
    const out = process.env.SHOT_PATH || path.join(APP_ROOT, 'screenshot-client.png')
    fs.writeFileSync(out, img.toPNG())
    console.log('[shot] saved:', out)
  } catch (e) {
    console.error('[shot] failed:', e)
    shotErrors++
  }
  // 有断言失败则以非零退出，让 CI / smoke 脚本能感知
  app.exit(shotErrors > 0 ? 1 : 0)
}
