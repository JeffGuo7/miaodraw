/**
 * 构建内置风格/提示词库 → library/styles.json
 *
 * 数据源（均来自本机已安装的提示词资产 skill，按许可使用）：
 *  1. handdraw-style-prompter  references/styles.json        261 套手绘风格（匿名化风格名 + 中文特征描述）
 *  2. gpt-image-2-style-library references/style-library.md  22 套商业/设计模板（含中英文要点）
 *  3. nanobanana-prompts       references/prompt-library.md  实战提示词精选（CC BY 4.0，保留出处）
 *
 * 用法：node scripts/build-styles.cjs [skillsRoot]
 *   默认 skillsRoot = %USERPROFILE%\.agents\skills
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SKILLS = process.argv[2] || path.join(process.env.USERPROFILE || '', '.agents', 'skills')
const OUT = path.join(ROOT, 'library', 'styles.json')

const styles = []
const groups = []
const seen = new Set()

/** 英文分类 → 中文标签（界面更友好） */
const CAT_ZH = {
  'UI & Interfaces': '界面与 UI',
  'Charts & Infographics': '信息图与图表',
  'Posters & Typography': '海报与字体',
  'Products & E-commerce': '商品与电商',
  'Brand & Logos': '品牌与标识',
  'Architecture & Spaces': '建筑与空间',
  'Photography & Realism': '摄影与写实',
  'Illustration & Art': '插画与艺术',
  'Characters & People': '角色与人物',
  'Scenes & Storytelling': '场景叙事',
  'History & Classical Themes': '历史与国风',
  'Documents & Publishing': '文档与出版',
  'Other Use Cases': '其他场景',
  'Photorealism & Aesthetics': '写实与美学',
  'Creative Experiments': '创意实验',
  'Education & Knowledge': '教育与知识',
  'E-commerce & Virtual Studio': '电商与虚拟影棚',
  'Product & Branding': '产品与品牌',
  'Social Media & Advertising': '社媒与广告',
  'Social Media & Marketing': '社媒与营销',
  'Character & Story': '角色与故事',
  'Utility & Technical': '实用与技术',
  'Workplace & Productivity': '职场与效率',
  'Photo Editing & Restoration': '修图与修复',
  'Interior Design': '室内设计',
  'Daily Life & Translation': '生活与翻译',
  'Social Networking & Avatars': '社交与头像',
  'Education & Knowledge': '教育与知识'
}
const zhCat = (c) => CAT_ZH[String(c || '').trim()] || String(c || '').trim()

function push(entry) {
  if (!entry.title || !entry.prompt || seen.has(entry.id)) return
  seen.add(entry.id)
  styles.push(entry)
}

/** 1) 手绘风格库：261 套。只用匿名风格名 + 中文特征，不写入真实作者名（规避署名/风格侵权风险） */
function buildHanddraw() {
  const file = path.join(SKILLS, 'handdraw-style-prompter', 'references', 'styles.json')
  if (!fs.existsSync(file)) return 0
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  let n = 0
  for (const it of raw) {
    const group = String(it.group || '手绘风格').trim()
    const shortCat = group.replace(/^[A-Z]\s*/, '').split('/')[0].trim() || '手绘风格'
    const traits = String(it.traits || '').trim()
    if (!traits) continue
    push({
      id: `hd-${it.number}`,
      title: String(it.generation_name || '').trim() || `手绘风格 ${it.number}`,
      category: shortCat,
      tags: ['手绘', shortCat],
      prompt: `${traits}\n\n（画风方向：${String(it.generation_name || '').trim()}；请用你自己的笔触与构图重新演绎主题，不要模仿任何具体在世艺术家的署名作品。）`,
      source: '手绘风格库',
      credit: 'handdraw-style-prompter（风格特征描述，匿名化）'
    })
    n++
  }
  groups.push({ id: 'handdraw', title: '手绘风格 · 261 套', note: '社论漫画、幽默手绘、绘本插图等，按风格族分组' })
  return n
}

/** 2) GPT-Image2 商业/设计模板：把中英文要点组装成可直接用的方向提示词 */
function buildGptImage2() {
  const before = styles.length
  const file = path.join(SKILLS, 'gpt-image-2-style-library', 'references', 'style-library.md')
  if (!fs.existsSync(file)) return 0
  const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/)
  let cur = null
  let section = ''
  const flush = () => {
    if (!cur) return
    const zh = cur.zh || []
    const guideZh = cur.guideZh || []
    const pitZh = cur.pitZh || []
    const parts = []
    if (zh.length) parts.push(...zh)
    if (guideZh.length) parts.push(`要点：${guideZh.join('；')}`)
    if (pitZh.length) parts.push(`避免：${pitZh.join('；')}`)
    const prompt = parts.join('\n').trim()
    if (prompt) {
      push({
        id: `gi-${cur.id}`,
        title: cur.titleZh || cur.titleEn,
        category: zhCat(cur.category || '商业模板'),
        tags: ['模板', zhCat(cur.category || '商业')].concat(cur.tags || []).slice(0, 5),
        prompt,
        source: 'GPT-Image2 模板库',
        credit: cur.credit
      })
    }
    cur = null
  }
  for (const line of lines) {
    const h = line.match(/^### (.+)$/)
    if (h) {
      flush()
      const [en, zh] = h[1].split('/').map((s) => s.trim())
      cur = { id: '', titleEn: en, titleZh: zh || en, category: '', tags: [], zh: [], guideZh: [], pitZh: [], credit: '' }
      section = 'head'
      continue
    }
    if (!cur) continue
    const idM = line.match(/^- ID: `([^`]+)`/)
    if (idM) { cur.id = idM[1]; continue }
    const catM = line.match(/^- Category: (.+)$/)
    if (catM) { cur.category = catM[1].trim(); continue }
    const tagM = line.match(/^- Tags: (.+)$/)
    if (tagM) { cur.tags = tagM[1].split(',').map((s) => s.trim()); continue }
    const srcM = line.match(/^- Template source: (\S+)/)
    if (srcM) { cur.credit = srcM[1]; continue }
    if (/^Use when:/.test(line)) { section = 'use'; continue }
    if (/^Guidance:/.test(line)) { section = 'guide'; continue }
    if (/^Pitfalls:/.test(line)) { section = 'pit'; continue }
    const zhM = line.match(/^\s*- ZH: (.+)$/)
    if (zhM) {
      const text = zhM[1].trim()
      if (section === 'use') cur.zh.push(text)
      else if (section === 'guide') cur.guideZh.push(text)
      else if (section === 'pit') cur.pitZh.push(text)
      continue
    }
    // 同一行的多条中文要点（形如 "- 中文；- 另一条"）
    if (section !== 'head' && /^\s{2,}- /.test(line) && /[\u4e00-\u9fa5]/.test(line)) {
      const text = line.replace(/^\s*-\s*/, '').trim()
      if (section === 'guide') cur.guideZh.push(text)
      else if (section === 'pit') cur.pitZh.push(text)
    }
  }
  flush()
  groups.push({ id: 'gptimage2', title: '商业设计模板 · 22 套', note: 'UI/信息图/海报/电商/品牌/3D 等版式与视觉方向' })
  return styles.length - before
}

/** 3) Nano Banana 实战提示词：完整可复制的提示词（CC BY 4.0，保留出处） */
function buildNanoBanana() {
  const before = styles.length
  const file = path.join(SKILLS, 'nanobanana-prompts', 'references', 'prompt-library.md')
  if (!fs.existsSync(file)) return 0
  const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/)
  let category = ''
  let cur = null
  let inCode = false
  let code = []
  const flush = () => {
    if (!cur) return
    const prompt = code.join('\n').trim()
    if (prompt && prompt.length > 30) {
      push({
        id: cur.id,
        title: cur.title,
        category: zhCat(category || '实战提示词'),
        tags: ['实战', zhCat(category || '提示词')],
        prompt,
        source: 'Nano Banana Pro 精选',
        credit: cur.credit || 'ZeroLu/awesome-nanobanana-pro (CC BY 4.0)'
      })
    }
    cur = null
    code = []
  }
  for (const line of lines) {
    const c2 = line.match(/^## \d+\.\s+(.+)$/)
    if (c2) { flush(); category = c2[1].trim(); continue }
    const h = line.match(/^### (\d+)\.(\d+)\.\s+(.+)$/)
    if (h) {
      flush()
      cur = { id: `nb-${h[1]}-${h[2]}`, title: h[3].trim(), credit: '' }
      continue
    }
    if (!cur) continue
    if (/^\*\*Prompt:\*\*/.test(line)) { inCode = true; code = []; continue }
    if (inCode) {
      if (/^```/.test(line)) {
        if (code.length) inCode = false
        continue
      }
      code.push(line)
      continue
    }
    const src = line.match(/^\*Source: (.+)\*$/)
    if (src) cur.credit = src[1].replace(/\[|\]|\(.*?\)/g, '').trim()
  }
  flush()
  groups.push({ id: 'nanobanana', title: '实战提示词 · 精选', note: '来自 Nano Banana Pro 社区的完整提示词（CC BY 4.0）' })
  return styles.length - before
}

const n1 = buildHanddraw()
const n2 = buildGptImage2()
const n3 = buildNanoBanana()

const payload = {
  version: 1,
  generatedAt: new Date().toISOString(),
  groups,
  sources: [
    { name: 'handdraw-style-prompter', license: '本机 skill 资产（风格描述为匿名化改写）' },
    { name: 'gpt-image-2-style-library', license: '本机 skill 资产' },
    { name: 'ZeroLu/awesome-nanobanana-pro', license: 'CC BY 4.0', url: 'https://github.com/ZeroLu/awesome-nanobanana-pro' }
  ],
  count: styles.length,
  styles
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1))
console.log(`手绘 ${n1} + 模板 ${n2} + 实战 ${n3} = ${styles.length} 条 → ${OUT}`)
console.log(`分类：${[...new Set(styles.map((s) => s.category))].slice(0, 24).join(' / ')}`)
