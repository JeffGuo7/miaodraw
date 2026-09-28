import path from 'node:path'
import fsp from 'node:fs/promises'
import { generate, runBl, type GenOpts } from './bl'
import { extractJson, plannerSystem, validatePlan, type PlanStep } from './tools'

export interface AgentEvent {
  runId: string
  stage: 'plan' | 'step' | 'done' | 'error'
  index?: number
  total?: number
  label?: string
  detail?: string
  reply?: string
}

export interface AgentRunResult {
  reply: string
  files: Array<{ file: string; url: string }>
  last: { file: string; url: string } | null
}

interface RunOpts {
  runId: string
  goal: string
  baseImage?: string // outputs 目录内的文件名（无扩展名歧义）
  defaultModel: string
  outputsDir: string
  onEvent: (e: AgentEvent) => void
}

function parseSize(v: unknown, fallbackW: number, fallbackH: number): { w: number; h: number } {
  const m = typeof v === 'string' ? v.match(/(\d{2,5})\s*[xX*×]\s*(\d{2,5})/) : null
  if (!m) return { w: fallbackW, h: fallbackH }
  return { w: Number(m[1]), h: Number(m[2]) }
}

export async function runAgent(opts: RunOpts): Promise<AgentRunResult> {
  const { runId, goal, outputsDir } = opts
  const hasBase = !!opts.baseImage
  const context = hasBase
    ? `已有图片 1 张（文件 ${opts.baseImage}），edit_image 可直接基于它修改。`
    : '画布为空，只能使用 generate_image。'

  // ---- 规划 ----
  opts.onEvent({ runId, stage: 'plan', label: 'AI 规划步骤中' })
  const r = await runBl(
    [
      'text', 'chat',
      '--model', 'qwen3.8-flash',
      '--system', plannerSystem(context),
      '--message', goal,
      '--temperature', '0.3',
      '--output', 'json',
      '--quiet',
      '--timeout', '120'
    ],
    180000
  )
  if (r.code !== 0) throw new Error((r.stdout + r.stderr).slice(-400))

  // bl text chat --output json 的信封里找 content；找不到再整体提 JSON
  let content = r.stdout
  try {
    const envelope = JSON.parse(r.stdout)
    content =
      envelope?.choices?.[0]?.message?.content ??
      envelope?.content ??
      envelope?.output?.text ??
      r.stdout
  } catch {
    /* 保持原文 */
  }
  let plan: { reply: string; steps: PlanStep[] }
  try {
    plan = validatePlan(extractJson(content))
  } catch (e) {
    throw new Error(`AI 规划失败：${e instanceof Error ? e.message : e}`)
  }
  if (plan.steps.length === 0) {
    return { reply: plan.reply || '这个需求当前工具还做不到。', files: [], last: null }
  }

  // ---- 顺序执行 ----
  const files: Array<{ file: string; url: string }> = []
  let currentAbs: string | null = opts.baseImage
    ? path.join(outputsDir, opts.baseImage)
    : null
  let currentName: string | undefined = opts.baseImage
  let i = 0
  for (const step of plan.steps) {
    i++
    const specLabel = step.tool === 'generate_image' ? '文生图' : '改图'
    opts.onEvent({
      runId,
      stage: 'step',
      index: i,
      total: plan.steps.length,
      label: `${specLabel}：${String(step.params.prompt ?? '').slice(0, 30)}`
    })
    const size = parseSize(step.params.size, 1024, 1024)
    // 改图必须用支持编辑的模型（wan2.7-image 只支持文生图）
    const stepModel = step.tool === 'edit_image' ? 'qwen-image-3.0-pro' : opts.defaultModel
    const genOpts: GenOpts = {
      prompt: String(step.params.prompt ?? ''),
      negative: typeof step.params.negative === 'string' ? step.params.negative : undefined,
      w: size.w,
      h: size.h,
      model: stepModel,
      parent: currentName,
      ref: currentAbs
        ? { name: path.basename(currentAbs), data: new Uint8Array(await fsp.readFile(currentAbs)).buffer as ArrayBuffer }
        : undefined
    }
    if (step.tool === 'edit_image' && !currentAbs) {
      throw new Error('没有可修改的图片，无法执行 edit_image')
    }
    const res = await generate(genOpts, outputsDir)
    files.push({ file: res.file, url: res.url })
    currentAbs = path.join(outputsDir, res.file)
    currentName = res.file
  }

  const last = files.length ? files[files.length - 1] : null
  opts.onEvent({ runId, stage: 'done', reply: plan.reply })
  return { reply: plan.reply, files, last }
}
