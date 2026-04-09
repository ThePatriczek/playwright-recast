import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ParsedTrace } from '../types/trace.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal action shape for grouping (decoupled from ParsedTrace for testability). */
export interface RawAction {
  callId: string
  method: string
  params: Record<string, unknown>
  startTime: number
  endTime: number
  title: string
  annotations?: Array<{ type: string; description?: string }>
}

/** A grouped user-facing step produced by the analyzer. */
export interface AnalyzedStep {
  id: string
  label: string
  hidden: boolean
  /** Indices into the ORIGINAL rawActions array. */
  actionIndices: number[]
  actions: Array<{
    method: string
    selector?: string
    value?: string
    url?: string
    text?: string
  }>
  startTimeMs: number
  endTimeMs: number
  durationMs: number
  thumbnailSha1?: string
}

/** Full analysis result returned by analyzeTrace. */
export interface AnalysisResult {
  metadata: {
    actionCount: number
    durationMs: number
    viewport: { width: number; height: number }
    url: string
  }
  steps: AnalyzedStep[]
}

// ---------------------------------------------------------------------------
// Hidden-detection helpers
// ---------------------------------------------------------------------------

const LOGIN_FIELD_RE = /password|email|login|username|user.?name|log.?in/i
const COOKIE_CONSENT_RE = /cookie|consent|accept|gdpr|privacy/i
const USER_FACING_METHODS = new Set([
  'click',
  'fill',
  'type',
  'press',
  'selectOption',
  'check',
  'uncheck',
  'goto',
])

/** Time gap threshold (ms) for splitting visible actions into separate steps. */
const GAP_THRESHOLD_MS = 5000

function selectorOf(params: Record<string, unknown>): string {
  return typeof params.selector === 'string' ? params.selector : ''
}

function valueOf(params: Record<string, unknown>): string {
  return typeof params.value === 'string' ? params.value : ''
}

function urlOf(params: Record<string, unknown>): string {
  return typeof params.url === 'string' ? params.url : ''
}

function hasAnnotation(action: RawAction, type: string): boolean {
  return action.annotations?.some((a) => a.type === type) ?? false
}

function isLoginField(selector: string): boolean {
  return LOGIN_FIELD_RE.test(selector)
}

function isCookieConsent(selector: string): boolean {
  return COOKIE_CONSENT_RE.test(selector)
}

// ---------------------------------------------------------------------------
// Per-action hidden classification
// ---------------------------------------------------------------------------

interface ClassifiedAction {
  index: number
  action: RawAction
  hidden: boolean
}

function classifyActions(rawActions: RawAction[]): ClassifiedAction[] {
  const classified: ClassifiedAction[] = rawActions.map((a, i) => ({
    index: i,
    action: a,
    hidden: false,
  }))

  // Pass 1: mark individually hidden actions
  for (let i = 0; i < classified.length; i++) {
    const { action } = classified[i]
    const sel = selectorOf(action.params)

    // First goto is always hidden (initial navigation)
    if (i === 0 && action.method === 'goto') {
      classified[i].hidden = true
      continue
    }

    // voiceover-hidden annotation
    if (hasAnnotation(action, 'voiceover-hidden')) {
      classified[i].hidden = true
      continue
    }

    // Cookie consent selectors
    if (isCookieConsent(sel)) {
      classified[i].hidden = true
      continue
    }

    // Login field fills + surrounding context
    if (action.method === 'fill' && isLoginField(sel)) {
      classified[i].hidden = true
      continue
    }
  }

  // Pass 2: propagate hidden from login fields to surrounding goto + submit click
  // Find contiguous runs that contain a login-field fill and mark the full run hidden.
  for (let i = 0; i < classified.length; i++) {
    const { action } = classified[i]
    const sel = selectorOf(action.params)

    if (action.method === 'fill' && isLoginField(sel)) {
      // Look backward for a goto or other fills that are part of the login form
      for (let j = i - 1; j >= 0; j--) {
        const prev = classified[j]
        if (prev.hidden) continue // already marked
        const prevMethod = prev.action.method
        const prevSel = selectorOf(prev.action.params)
        if (prevMethod === 'goto' || prevMethod === 'fill' || (prevMethod === 'click' && isLoginField(prevSel))) {
          prev.hidden = true
        } else {
          break
        }
      }
      // Look forward for submit click or other login fills.
      // Do NOT skip already-hidden items — they mark the boundary of
      // a run that was already processed, so jumping over them would
      // accidentally hide unrelated actions further ahead.
      for (let j = i + 1; j < classified.length; j++) {
        const next = classified[j]
        if (next.hidden) break // already part of a processed run — stop
        const nextMethod = next.action.method
        const nextSel = selectorOf(next.action.params)
        if (nextMethod === 'fill' && isLoginField(nextSel)) {
          next.hidden = true
        } else if (nextMethod === 'click') {
          // Mark the next click as hidden (submit button) then stop
          next.hidden = true
          break
        } else {
          break
        }
      }
    }
  }

  return classified
}

// ---------------------------------------------------------------------------
// Label generation
// ---------------------------------------------------------------------------

function sanitizeSelector(selector: string): string {
  // Strip [data-testid="..."] patterns
  const stripped = selector.replace(/\[data-testid="[^"]*"\]/g, '').trim()
  if (stripped) return stripped
  // If stripping removed the entire selector, extract the testid value as a
  // human-readable name (e.g. "save-button" → "save-button")
  const match = selector.match(/\[data-testid="([^"]*)"\]/)
  return match?.[1] ?? ''
}

function extractQuotedText(title: string | undefined): string | undefined {
  if (!title) return undefined
  const match = title.match(/"([^"]+)"/)
  return match?.[1]
}

function lastPathSegment(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const segments = pathname.split('/').filter(Boolean)
    return segments[segments.length - 1] ?? pathname
  } catch {
    return url
  }
}

function maskIfPassword(selector: string, value: string): string {
  if (/password/i.test(selector)) return '***'
  return value
}

function generateLabel(actions: ClassifiedAction[]): string {
  if (actions.length === 0) return 'Step'

  const first = actions[0].action
  const methods = actions.map((a) => a.action.method)

  // click + fill combo → "Search for 'value'" or "Type 'value' in [field]"
  if (methods.includes('click') && methods.includes('fill')) {
    const fillAction = actions.find((a) => a.action.method === 'fill')!
    const value = valueOf(fillAction.action.params)
    const sel = selectorOf(fillAction.action.params)
    const maskedValue = maskIfPassword(sel, value)
    if (maskedValue) {
      return `Search for '${maskedValue}'`
    }
    return 'Fill field'
  }

  // Single action labels
  if (actions.length === 1 || methods.every((m) => m === first.method)) {
    return generateSingleLabel(first)
  }

  // Mixed actions: use the first one
  return generateSingleLabel(first)
}

function generateSingleLabel(action: RawAction): string {
  const { method, params, title } = action
  const sel = selectorOf(params)

  switch (method) {
    case 'goto': {
      const url = urlOf(params)
      return `Navigate to ${lastPathSegment(url)}`
    }
    case 'click': {
      const quoted = extractQuotedText(title)
      if (quoted) return `Click ${quoted}`
      const sanitized = sanitizeSelector(sel)
      return sanitized ? `Click ${sanitized}` : 'Click'
    }
    case 'fill': {
      const value = valueOf(params)
      const maskedValue = maskIfPassword(sel, value)
      const sanitized = sanitizeSelector(sel)
      if (maskedValue && sanitized) return `Type '${maskedValue}' in ${sanitized}`
      if (maskedValue) return `Type '${maskedValue}'`
      return 'Fill field'
    }
    case 'type': {
      const value = valueOf(params)
      return value ? `Type '${value}'` : 'Type text'
    }
    case 'press': {
      const key = typeof params.key === 'string' ? params.key : 'key'
      return `Press ${key}`
    }
    case 'selectOption': {
      const values = params.values
      const text =
        Array.isArray(values) && values.length > 0
          ? String(values[0])
          : typeof params.value === 'string'
            ? params.value
            : ''
      return text ? `Select '${text}'` : 'Select option'
    }
    case 'check':
      return 'Check option'
    case 'uncheck':
      return 'Uncheck option'
    default:
      return method.charAt(0).toUpperCase() + method.slice(1)
  }
}

// ---------------------------------------------------------------------------
// Action detail extraction (for the step.actions array)
// ---------------------------------------------------------------------------

function extractActionDetail(
  action: RawAction,
): AnalyzedStep['actions'][number] {
  const sel = selectorOf(action.params)
  const val = valueOf(action.params)
  const url = urlOf(action.params)
  const quoted = extractQuotedText(action.title)

  return {
    method: action.method,
    ...(sel ? { selector: sanitizeSelector(sel) } : {}),
    ...(val ? { value: maskIfPassword(sel, val) } : {}),
    ...(url ? { url } : {}),
    ...(quoted ? { text: quoted } : {}),
  }
}

// ---------------------------------------------------------------------------
// Main grouping function
// ---------------------------------------------------------------------------

let stepCounter = 0

function nextStepId(): string {
  return `step-${++stepCounter}`
}

/**
 * Group raw trace actions into logical user-facing steps with labels and
 * hidden detection.
 */
export function groupActions(rawActions: RawAction[]): AnalyzedStep[] {
  if (rawActions.length === 0) return []

  // Reset counter per call for deterministic IDs in tests
  stepCounter = 0

  const classified = classifyActions(rawActions)

  // Filter to user-facing methods only (keep track of original indices)
  const userFacing = classified.filter((c) =>
    USER_FACING_METHODS.has(c.action.method),
  )

  if (userFacing.length === 0) return []

  // Build groups: consecutive hidden actions merge, visible actions group by
  // proximity and click+fill merging.
  const groups: ClassifiedAction[][] = []
  let currentGroup: ClassifiedAction[] = [userFacing[0]]

  for (let i = 1; i < userFacing.length; i++) {
    const prev = userFacing[i - 1]
    const curr = userFacing[i]

    const bothHidden = prev.hidden && curr.hidden
    const bothVisible = !prev.hidden && !curr.hidden
    const timeDelta = curr.action.startTime - prev.action.endTime

    if (bothHidden) {
      // Merge consecutive hidden actions
      currentGroup.push(curr)
    } else if (bothVisible) {
      // A goto always starts a new step — it is a distinct navigation
      if (curr.action.method === 'goto') {
        groups.push(currentGroup)
        currentGroup = [curr]
        continue
      }

      // Check for click + fill merge on same/related selector
      const canMerge = canMergeActions(prev.action, curr.action)
      const withinTimeWindow = timeDelta <= GAP_THRESHOLD_MS

      if (canMerge && withinTimeWindow) {
        currentGroup.push(curr)
      } else if (withinTimeWindow && !isClickFillBoundary(currentGroup, curr)) {
        // Within time window and no click+fill boundary forcing split
        currentGroup.push(curr)
      } else {
        groups.push(currentGroup)
        currentGroup = [curr]
      }
    } else {
      // Transition between hidden and visible → new group
      groups.push(currentGroup)
      currentGroup = [curr]
    }
  }
  groups.push(currentGroup)

  // Convert groups to AnalyzedSteps
  return groups.map((group) => {
    const hidden = group[0].hidden
    const actionIndices = group.map((c) => c.index)
    const actions = group.map((c) => extractActionDetail(c.action))
    const startTimeMs = Math.min(...group.map((c) => c.action.startTime))
    const endTimeMs = Math.max(...group.map((c) => c.action.endTime))

    return {
      id: nextStepId(),
      label: hidden ? 'Setup' : generateLabel(group),
      hidden,
      actionIndices,
      actions,
      startTimeMs,
      endTimeMs,
      durationMs: endTimeMs - startTimeMs,
    }
  })
}

/** Check if two actions can be merged (click + fill on same selector). */
function canMergeActions(a: RawAction, b: RawAction): boolean {
  const aMethod = a.method
  const bMethod = b.method
  const aSel = selectorOf(a.params)
  const bSel = selectorOf(b.params)

  // click followed by fill (or vice versa) on same/related selector
  if (
    (aMethod === 'click' && bMethod === 'fill') ||
    (aMethod === 'fill' && bMethod === 'click')
  ) {
    return aSel === bSel || selectorsRelated(aSel, bSel)
  }
  return false
}

/** Rough heuristic: selectors share a common class or root. */
function selectorsRelated(a: string, b: string): boolean {
  if (!a || !b) return false
  // Same base selector without pseudo-classes or attribute selectors
  const baseA = a.split(/[\s>[:]/, 1)[0]
  const baseB = b.split(/[\s>[:]/, 1)[0]
  return baseA.length > 0 && baseA === baseB
}

/**
 * Prevent merging a new action into a group that already contains a completed
 * click+fill pair (to avoid lumping unrelated actions together).
 */
function isClickFillBoundary(
  group: ClassifiedAction[],
  next: ClassifiedAction,
): boolean {
  const methods = group.map((c) => c.action.method)
  const hasClick = methods.includes('click')
  const hasFill = methods.includes('fill')
  // If group already has click+fill and next is neither, it's a boundary
  if (hasClick && hasFill && next.action.method !== 'click' && next.action.method !== 'fill') {
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Full trace analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a full Playwright trace: parse, group actions, extract thumbnails.
 */
export async function analyzeTrace(
  traceDir: string,
): Promise<AnalysisResult & { dispose: () => void }> {
  // Dynamic import to keep groupActions unit-testable without trace files
  const { parseTrace } = await import('../parse/trace-parser.js')

  const tracePath = traceDir.endsWith('.zip') ? traceDir : `${traceDir}/trace.zip`
  const parsed: ParsedTrace = await parseTrace(tracePath)
  const { metadata, actions, frames, frameReader } = parsed

  // Convert TraceAction[] → RawAction[]
  const rawActions: RawAction[] = actions.map((a) => ({
    callId: a.callId,
    method: a.method,
    params: a.params,
    startTime: a.startTime as number,
    endTime: a.endTime as number,
    title: a.title ?? '',
    annotations: a.annotations?.map((ann) => ({
      type: ann.type,
      description: ann.description,
    })),
  }))

  const steps = groupActions(rawActions)

  // Extract thumbnail JPEGs: for each step, find closest screencast frame
  // to startTime + 500ms and save to <traceDir>/thumbnails/<stepId>.jpg
  const thumbDir = join(traceDir, '..', 'thumbnails')
  if (steps.length > 0 && frames.length > 0) {
    if (!existsSync(thumbDir)) {
      mkdirSync(thumbDir, { recursive: true })
    }

    for (const step of steps) {
      const targetTime = step.startTimeMs + 500
      let closest = frames[0]
      let closestDelta = Math.abs((closest.timestamp as number) - targetTime)

      for (const frame of frames) {
        const delta = Math.abs((frame.timestamp as number) - targetTime)
        if (delta < closestDelta) {
          closest = frame
          closestDelta = delta
        }
      }

      step.thumbnailSha1 = closest.sha1
      try {
        const buf = await frameReader.readFrame(closest.sha1)
        writeFileSync(join(thumbDir, `${step.id}.jpg`), buf)
      } catch {
        // Frame might not be available — skip thumbnail
      }
    }
  }

  // Determine initial URL from first goto action
  const firstGoto = rawActions.find((a) => a.method === 'goto')
  const initialUrl = firstGoto ? urlOf(firstGoto.params) : ''

  const totalDuration =
    rawActions.length > 0
      ? Math.max(...rawActions.map((a) => a.endTime)) -
        Math.min(...rawActions.map((a) => a.startTime))
      : 0

  return {
    metadata: {
      actionCount: rawActions.length,
      durationMs: totalDuration,
      viewport: metadata.viewport,
      url: initialUrl,
    },
    steps,
    dispose: () => frameReader.dispose(),
  }
}
