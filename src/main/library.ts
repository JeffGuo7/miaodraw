import { nativeImage } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export interface LibCase {
  n: number
  key?: string
  title: string
  prompt: string
  img: string
  desc?: string
  tags?: string[]
  source?: string
  featured?: boolean
}

export interface LibCategory {
  label: string
  cases: LibCase[]
}

export interface LibraryData {
  cats: Record<string, LibCategory>
  total: number
  dupsRemoved: number
}

/** 案例库根目录：开发态在项目内，打包后在 resources */
export function libraryRoot(isPackaged: boolean, appPath: string, resourcesPath: string): string {
  return isPackaged ? path.join(resourcesPath, 'library') : path.join(appPath, 'library')
}

const CATS_A: Array<[string, string]> = [
  ['ad-creative', '广告创意'],
  ['character', '角色设计'],
  ['comparison', '对比图'],
  ['ecommerce', '电商'],
  ['portrait', '人像'],
  ['poster', '海报'],
  ['ui', 'UI 设计']
]

const CAT_ZH: Record<string, string> = {
  'Posters & Typography': '海报与排版',
  'Photography & Realism': '摄影与写实',
  'UI & Interfaces': 'UI 与界面',
  'Illustration & Art': '插画与艺术',
  'Charts & Infographics': '图表与信息图',
  'Products & E-commerce': '产品与电商',
  'Characters & People': '角色与人物',
  'Brand & Logos': '品牌与标志',
  'Scenes & Storytelling': '场景与叙事',
  'History & Classical Themes': '历史与古典',
  'Architecture & Spaces': '建筑与空间',
  'Documents & Publishing': '文档与出版',
  'Other Use Cases': '其他'
}

// ---------- 解析 ----------

function parseLibA(root: string): { groups: Array<{ stem: string; label: string; cases: LibCase[] }> } {
  const groups: Array<{ stem: string; label: string; cases: LibCase[] }> = []
  const imagesDir = path.join(root, 'libA', 'images')
  for (const [stem, label] of CATS_A) {
    let p = path.join(root, 'libA', 'cases', `${stem}_zh-CN.md`)
    if (!fs.existsSync(p)) p = path.join(root, 'libA', 'cases', `${stem}.md`)
    if (!fs.existsSync(p)) continue
    const text = fs.readFileSync(p, 'utf-8')
    const cases: LibCase[] = []
    const seenInFile = new Set<string>()
    const keyCount = new Map<number, number>()
    for (const chunk of text.split(/^### Case /m).slice(1)) {
      const head = chunk.match(/^(\d+):\s*\[([^\]]+)\]/)
      if (!head) continue
      const pm = chunk.match(/```[^\n]*\n([\s\S]*?)```/)
      if (!pm) continue
      const im = chunk.match(/<img src="[^"]*?\/images\/([^"]+?)"/)
      let img = im ? im[1].split('?')[0] : ''
      const absImg = img ? path.join(imagesDir, ...img.split('/')) : ''
      if (img && !fs.existsSync(absImg)) img = ''
      const prompt = pm[1].trim()
      const pk = prompt.replace(/\s+/g, ' ').toLowerCase().slice(0, 100)
      // 同文件内完全相同的提示词 = 源数据噪声，跳过（避免 React key 撞车）
      if (seenInFile.has(pk)) continue
      seenInFile.add(pk)
      const n = parseInt(head[1], 10)
      const occ = keyCount.get(n) ?? 0
      keyCount.set(n, occ + 1)
      cases.push({
        n,
        key: occ === 0 ? `a:${stem}:${n}` : `a:${stem}:${n}#${occ}`,
        title: head[2].trim(),
        prompt,
        img,
        desc: prompt.replace(/\s+/g, ' ').slice(0, 110),
        tags: [label]
      })
    }
    if (cases.length) groups.push({ stem, label, cases })
  }
  return { groups }
}

function parseLibB(root: string): Array<{ c: LibCase; key: string; cat: string; absImg: string }> {
  const p = path.join(root, 'libB', 'data', 'cases.json')
  if (!fs.existsSync(p)) return []
  const d = JSON.parse(fs.readFileSync(p, 'utf-8')) as { cases?: Array<Record<string, unknown>> }
  const imagesDir = path.join(root, 'libB', 'data', 'images')
  const out: Array<{ c: LibCase; key: string; cat: string; absImg: string }> = []
  for (const c of d.cases ?? []) {
    const cat0 = String(c.category ?? '')
    const cat = CAT_ZH[cat0] ?? cat0 ?? '其他'
    let img = c.image ? path.basename(String(c.image)) : ''
    const absImg = img ? path.join(imagesDir, img) : ''
    if (img && !fs.existsSync(absImg)) img = ''
    const prompt = String(c.prompt ?? '')
    let styles: string[] = []
    if (Array.isArray(c.styles)) styles = (c.styles as unknown[]).map(String)
    else {
      const raw = String(c.styles ?? '')
      styles = raw.includes("'")
        ? (raw.match(/'([^']+)'/g) ?? []).map((s) => s.replace(/'/g, ''))
        : raw.split(',').map((s) => s.trim()).filter(Boolean)
    }
    const tags = [...new Set([cat, ...styles])].filter(Boolean).slice(0, 4)
    out.push({
      c: {
        n: Number(c.id ?? 0),
        title: String(c.title ?? ''),
        prompt,
        img,
        desc: String(c.promptPreview ?? '').replace(/\s+/g, ' ').slice(0, 110) || prompt.replace(/\s+/g, ' ').slice(0, 110),
        tags,
        source: c.sourceLabel ? String(c.sourceLabel) : undefined,
        featured: String(c.featured ?? '') === 'True'
      },
      key: `b:${c.id ?? 0}`,
      cat,
      absImg
    })
  }
  return out
}

// ---------- 视觉感知去重（dHash，带磁盘缓存） ----------

function dHash(file: string): bigint | null {
  try {
    const img = nativeImage.createFromPath(file)
    if (img.isEmpty()) return null
    const resized = img.resize({ width: 9, height: 8 })
    const buf = resized.getBitmap()
    const gray: number[] = []
    for (let i = 0; i < 72; i++) {
      const o = i * 4
      gray.push(0.299 * buf[o + 2] + 0.587 * buf[o + 1] + 0.114 * buf[o])
    }
    let bits = 0n
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const bit = BigInt(y * 8 + x)
        if (gray[y * 9 + x] > gray[y * 9 + x + 1]) bits |= 1n << bit
      }
    }
    return bits
  } catch {
    return null
  }
}

function hamming(a: bigint, b: bigint): number {
  let x = a ^ b
  let n = 0
  while (x) {
    x &= x - 1n
    n++
  }
  return n
}

interface HashCache {
  [file: string]: { m: number; h: string }
}

async function loadHashCache(cacheFile: string): Promise<HashCache> {
  try {
    return JSON.parse(await fsp.readFile(cacheFile, 'utf-8')) as HashCache
  } catch {
    return {}
  }
}

async function hashWithCache(file: string, cache: HashCache, dirty: { v: boolean }): Promise<bigint | null> {
  let st: fs.Stats
  try {
    st = await fsp.stat(file)
  } catch {
    return null
  }
  const hit = cache[file]
  if (hit && hit.m === st.mtimeMs) return BigInt('0x' + hit.h)
  const h = dHash(file)
  if (h !== null) {
    cache[file] = { m: st.mtimeMs, h: h.toString(16) }
    dirty.v = true
  }
  return h
}

// ---------- 合并 ----------

const normKey = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100)
const normTitle = (s: string): string => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '')

export async function loadLibrary(root: string, cacheFile: string): Promise<LibraryData> {
  const a = parseLibA(root)
  const b = parseLibB(root)

  // 1) libA 为基底，按提示词跨分类去重
  const seenPrompts = new Set<string>()
  const seenTitles = new Set<string>()
  const keptA: Array<{ c: LibCase; key: string; absImg: string; stem: string; label: string }> = []
  let dupsRemoved = 0
  for (const g of a.groups) {
    for (const c of g.cases) {
      const pk = normKey(c.prompt)
      if (seenPrompts.has(pk)) {
        dupsRemoved++
        continue
      }
      seenPrompts.add(pk)
      seenTitles.add(normTitle(c.title))
      keptA.push({ c, key: c.key!, absImg: c.img ? path.join(root, 'libA', 'images', ...c.img.split('/')) : '', stem: g.stem, label: g.label })
    }
  }

  // 2) libB：标题与提示词都未出现过的才作为候选
  const candidates = b.filter(
    (item) => !seenTitles.has(normTitle(item.c.title)) && !seenPrompts.has(normKey(item.c.prompt))
  )
  dupsRemoved += b.length - candidates.length

  // 3) 视觉去重：候选图与已保留图哈希比对（阈值 8/64 位）
  const cache = await loadHashCache(cacheFile)
  const dirty = { v: false }
  const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r))
  const keptHashes: Array<{ h: bigint; img: string }> = []
  for (let i = 0; i < keptA.length; i++) {
    const item = keptA[i]
    if (!item.absImg) continue
    const h = await hashWithCache(item.absImg, cache, dirty)
    if (h !== null) keptHashes.push({ h, img: item.absImg })
    // 让出事件循环，避免首次建索引时冻结界面
    if (i % 8 === 7) await yieldLoop()
  }
  const keptB: typeof candidates = []
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i]
    if (!item.absImg) {
      keptB.push(item)
      continue
    }
    const h = await hashWithCache(item.absImg, cache, dirty)
    if (h === null) {
      keptB.push(item)
      continue
    }
    if (keptHashes.some((k) => hamming(k.h, h) <= 8)) {
      dupsRemoved++
      continue
    }
    keptHashes.push({ h, img: item.absImg })
    keptB.push(item)
    if (i % 8 === 7) await yieldLoop()
  }
  if (dirty.v) {
    try {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true })
      await fsp.writeFile(cacheFile, JSON.stringify(cache))
    } catch {
      /* 缓存写失败不影响功能 */
    }
  }

  // 4) 组装分类：只装去重后的案例，libA 分类序在前，libB-only 归入其中文分类
  const cats: Record<string, LibCategory> = {}
  for (const item of keptA) {
    cats[item.stem] ??= { label: item.label, cases: [] }
    cats[item.stem].cases.push(item.c)
  }
  for (const item of keptB) {
    cats[item.cat] ??= { label: item.cat, cases: [] }
    item.c.key = item.key
    cats[item.cat].cases.push(item.c)
  }

  const total = Object.values(cats).reduce((n, c) => n + c.cases.length, 0)
  return { cats, total, dupsRemoved }
}
