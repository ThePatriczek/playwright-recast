import { constrainPose, focusInShot, overview, type CameraKeyframe, type CameraPose, type FocusRegion } from './camera-rig.ts'

export const cameraActions = ['focus', 'fit', 'follow', 'reveal', 'overview', 'spotlight', 'pulse', 'stay'] as const
export type CameraAction = typeof cameraActions[number]
export type TargetSample = { atMs: number; region: FocusRegion | null }
export type CameraEffect = { kind: 'spotlight' | 'pulse'; atMs: number; endMs: number; target: FocusRegion }
export type ActionContext = {
  focus?: FocusRegion
  related: FocusRegion[]
  result?: FocusRegion
  track?: TargetSample[]
}
export type ActionPlan = {
  action: CameraAction
  keyframes: CameraKeyframe[]
  effects: CameraEffect[]
  targets: FocusRegion[]
  reason: string
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const distance = (a: CameraPose, b: CameraPose) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.zoom - b.zoom)

export function visibleRegion(region: FocusRegion): FocusRegion | undefined {
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0) return undefined
  const x = clamp(region.x, 0, 1)
  const y = clamp(region.y, 0, 1)
  const right = clamp(region.x + region.width, 0, 1)
  const bottom = clamp(region.y + region.height, 0, 1)
  if (x === region.x && y === region.y && right === region.x + region.width && bottom === region.y + region.height) return { ...region }
  return right > x && bottom > y ? { ...region, x, y, width: right - x, height: bottom - y } : undefined
}

export function frameTargets(targets: FocusRegion[], maxZoom = 1.45): CameraPose {
  const regions = targets.flatMap(target => visibleRegion(target) || [])
  if (!regions.length) return { ...overview }
  const left = Math.min(...regions.map(target => target.x))
  const top = Math.min(...regions.map(target => target.y))
  const right = Math.max(...regions.map(target => target.x + target.width))
  const bottom = Math.max(...regions.map(target => target.y + target.height))
  return constrainPose({ x: (left + right) / 2, y: (top + bottom) / 2, zoom: Math.min(maxZoom, 1 / (right - left + 0.16), 1 / (bottom - top + 0.16)) })
}

export function planAction(action: CameraAction, pose: CameraPose, context: ActionContext, atMs: number, endMs: number): ActionPlan {
  if (!Number.isFinite(atMs) || !Number.isFinite(endMs) || endMs <= atMs) throw new Error('Camera action needs a positive finite duration')
  const hold = (reason: string): ActionPlan => ({ action: 'stay', keyframes: [{ ...pose, atMs }, { ...pose, atMs: endMs }], effects: [], targets: [], reason })
  const move = (to: CameraPose, targets: FocusRegion[], reason: string): ActionPlan => {
    if (distance(pose, to) < 0.015) return { ...hold('already-framed'), targets }
    const arrival = Math.min(endMs, atMs + 950)
    return { action, keyframes: [{ ...pose, atMs }, { ...to, atMs: arrival }, ...(arrival < endMs ? [{ ...to, atMs: endMs }] : [])], effects: [], targets, reason }
  }
  const target = context.focus && visibleRegion(context.focus)
  switch (action) {
    case 'stay': return hold('hold-composition')
    case 'overview': return move(overview, [], 'restore-context')
    case 'focus': return target ? move(frameTargets([target]), [target], 'frame-subject') : hold('missing-target')
    case 'fit': {
      const targets = context.related.flatMap(region => visibleRegion(region) || [])
      return targets.length >= 2 ? move(frameTargets(targets), targets, 'frame-related-subjects') : hold('missing-related-targets')
    }
    case 'reveal': {
      const result = context.result && visibleRegion(context.result)
      return result ? move(frameTargets([result], 1.35), [result], 'show-observed-result') : hold('missing-result')
    }
    case 'follow': {
      const samples = (context.track || []).filter(sample => sample.atMs >= atMs && sample.atMs <= endMs)
      if (samples.some((sample, index) => index > 0 && sample.atMs <= samples[index - 1].atMs)) throw new Error('Tracking samples must strictly increase')
      if (samples.filter(sample => sample.region && visibleRegion(sample.region)).length < 2) return hold('missing-track')
      const points: CameraKeyframe[] = [{ ...pose, atMs }]
      const targets: FocusRegion[] = []
      let current = pose
      let lost = false
      for (const sample of samples) {
        const region = sample.region && visibleRegion(sample.region)
        if (!region) { lost = true; break }
        targets.push(region)
        if (sample.atMs <= atMs) continue
        const desired = frameTargets([region], Math.max(pose.zoom, 1.45))
        const elapsed = sample.atMs - points[points.length - 1].atMs
        const factor = Math.min(1, elapsed / 220)
        current = constrainPose({ x: current.x + (desired.x - current.x) * factor, y: current.y + (desired.y - current.y) * factor, zoom: current.zoom + (desired.zoom - current.zoom) * factor })
        points.push({ ...current, atMs: sample.atMs })
      }
      if (points[points.length - 1].atMs < endMs) points.push({ ...current, atMs: endMs })
      return { action, keyframes: points, effects: [], targets, reason: lost ? 'target-lost-hold-last-position' : 'follow-observed-positions' }
    }
    case 'spotlight':
    case 'pulse': {
      if (!target) return hold('missing-target')
      if (focusInShot(pose, target).visibleFraction < 0.95) return hold('target-outside-shot')
      const effectEnd = action === 'pulse' ? Math.min(endMs, atMs + 1000) : endMs
      return { ...hold('emphasize-without-moving'), action, targets: [target], effects: [{ kind: action, atMs, endMs: effectEnd, target }] }
    }
  }
}

export function actionCandidates(pose: CameraPose, context: ActionContext, atMs: number, endMs: number): Partial<Record<CameraAction, ActionPlan>> {
  return Object.fromEntries(cameraActions.flatMap(action => {
    const plan = planAction(action, pose, context, atMs, endMs)
    return plan.action === action ? [[action, plan]] : []
  }))
}

export function stabilizeAction(proposal: { choice: string; confidence: number; probabilities: Record<string, number> }, candidates: Partial<Record<CameraAction, ActionPlan>>, pose: CameraPose, atMs: number, lastMoveEndMs: number, lastEffectEndMs: number): { action: CameraAction; reason: string } {
  const action = cameraActions.find(name => name === proposal.choice)
  if (!action || !candidates[action]) throw new Error('Unavailable camera action')
  if (action === 'stay') return { action, reason: 'model-stay' }
  const advantage = (proposal.probabilities[action] || 0) - (proposal.probabilities.stay || 0)
  if (proposal.confidence < 0.55 || advantage < 0.25) return { action: 'stay', reason: 'uncertain-action' }
  const plan = candidates[action]!
  if (plan.effects.length) return atMs - lastEffectEndMs < 2200 ? { action: 'stay', reason: 'effect-cooldown' } : { action, reason: 'clear-emphasis-benefit' }
  const clipped = plan.targets.some(target => focusInShot(pose, target).visibleFraction < 0.6)
  if (atMs - lastMoveEndMs < 2200 && !clipped) return { action: 'stay', reason: 'settling' }
  return { action, reason: 'clear-framing-benefit' }
}

export function buildEffectGraph(effects: CameraEffect[], width: number, height: number): { graph: string; output: string } {
  let input = '0:v'
  const graph: string[] = []
  for (const [index, effect] of effects.entries()) {
    const target = visibleRegion(effect.target)
    if (!target || effect.endMs <= effect.atMs) throw new Error('Invalid camera effect')
    const left = Math.max(0, Math.floor(target.x * width) - 10)
    const top = Math.max(0, Math.floor(target.y * height) - 10)
    const right = Math.min(width, Math.ceil((target.x + target.width) * width) + 10)
    const bottom = Math.min(height, Math.ceil((target.y + target.height) * height) + 10)
    const boxes = effect.kind === 'spotlight'
      ? [[0, 0, width, top], [0, bottom, width, height - bottom], [0, top, left, bottom - top], [right, top, width - right, bottom - top]].filter(([, , w, h]) => w > 0 && h > 0).map(([x, y, w, h]) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@0.58:t=fill`)
      : [0, 6, 12].map((padding, ring) => `drawbox=x=${Math.max(0, left - padding)}:y=${Math.max(0, top - padding)}:w=${Math.min(width, right + padding) - Math.max(0, left - padding)}:h=${Math.min(height, bottom + padding) - Math.max(0, top - padding)}:color=0x9BB0FF@${[1, 0.5, 0.2][ring]}:t=3`)
    if (!boxes.length) continue
    const start = effect.atMs / 1000
    const duration = (effect.endMs - effect.atMs) / 1000
    const fade = Math.min(0.2, duration / 3)
    const envelope = `max(0,min(1,min((T-${start})/${fade},(${start + duration}-T)/${fade})))`
    const weight = effect.kind === 'pulse' ? `(${envelope})*(0.35+0.65*pow(sin(2*PI*(T-${start})/${duration}),2))` : envelope
    graph.push(`[${input}]split[base${index}][paint${index}]`, `[paint${index}]${boxes.join(',')}[painted${index}]`, `[base${index}][painted${index}]blend=all_expr='A+(B-A)*(${weight})':enable='between(t,${start},${start + duration})'[effect${index}]`)
    input = `effect${index}`
  }
  return { graph: graph.join(';'), output: input }
}
