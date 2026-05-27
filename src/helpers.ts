import type { Page, Locator, TestInfo } from '@playwright/test'

type StepFn = <T>(title: string, body: () => T | Promise<T>) => Promise<T>
type RecastTest = { info: () => TestInfo; step: StepFn }

/** Accepted shapes for `narrate`'s autoWait — see `narrate()` for semantics. */
type NarrateAutoWait =
  | boolean
  | number
  | { charactersPerSecond?: number; minMs?: number; maxMs?: number }

/**
 * Get current test info — works in both playwright-bdd and standard Playwright.
 * Must be called from within a test context.
 */
function getTestInfo(): TestInfo {
  throw new Error(
    'getTestInfo() must be overridden. Call setupRecast(test) first.',
  )
}

let _getTestInfo: () => TestInfo = getTestInfo
let _step: StepFn | null = null
/** Global default for `narrate`'s autoWait, applied when a call omits its own
 *  `autoWait`. Set via setupRecast; undefined (off) by default. */
let _narrateAutoWait: NarrateAutoWait | undefined = undefined

/**
 * Title prefix written to a trace step by `narrate()`. The `subtitlesFromTrace`
 * pipeline stage looks for this prefix to recover the narration text and
 * compute the subtitle's time window (this narrate → next narrate).
 */
export const NARRATE_TITLE_PREFIX = '__recast_narrate__: '
/** Same as `NARRATE_TITLE_PREFIX` but the step is excluded from subtitles. */
export const NARRATE_HIDDEN_TITLE_PREFIX = '__recast_narrate_hidden__: '
/** Title prefix written to a trace step by `highlight()`. JSON payload carries
 *  the viewport-pixel bounding box and styling overrides. */
export const HIGHLIGHT_TITLE_PREFIX = '__recast_highlight__: '
/** Title prefix written to a trace step by `zoom()`. JSON payload carries
 *  the center as (x, y) viewport fractions and the zoom level. */
export const ZOOM_TITLE_PREFIX = '__recast_zoom__: '

/** Characters-per-second used by `narrate({ autoWait: true })` to estimate
 *  how long the narration will take to speak. Character count is more
 *  language-robust than word count (cf. German compounds vs. English).
 *  14 ch/s ≈ 150 wpm × 5 chars/word / 60s, a typical conversational pace. */
export const NARRATE_DEFAULT_CPS = 14

function estimateNarrationMs(text: string, charsPerSecond: number): number {
  // Count non-whitespace characters — whitespace inflates length without
  // adding spoken time.
  const chars = text.replace(/\s+/g, '').length
  if (chars === 0 || charsPerSecond <= 0) return 0
  return Math.round((chars / charsPerSecond) * 1000)
}

/**
 * Initialize playwright-recast helpers with the test instance.
 * Call once in your fixtures file:
 *
 * ```typescript
 * import { test } from 'playwright-bdd' // or '@playwright/test'
 * import { setupRecast } from 'playwright-recast'
 * setupRecast(test)
 * ```
 *
 * @param options.narrateAutoWait Default `autoWait` applied to every `narrate()`
 *   call that omits its own (default: off). Same shapes as `narrate`'s
 *   per-call `autoWait`: `true`, a number of ms, or `{ charactersPerSecond,
 *   minMs, maxMs }`. A per-call `autoWait` (including `false`) overrides this.
 */
export function setupRecast(
  testInstance: RecastTest,
  options?: { narrateAutoWait?: NarrateAutoWait },
): void {
  _getTestInfo = () => testInstance.info()
  _step = testInstance.step.bind(testInstance)
  _narrateAutoWait = options?.narrateAutoWait
}

/**
 * Attach voiceover narration text to the current point in the test.
 *
 * Emits a `test.step()` with a marker-prefixed title so the narration is
 * recorded in the trace zip. `subtitlesFromTrace` later groups each narrate
 * step's text into a subtitle that spans until the next narrate call (or the
 * end of the trace). Also pushes a `voiceover` annotation onto `testInfo` so
 * external reporters can still read it from the JSON report.
 *
 * @param text Narration text. Pass undefined to no-op.
 * @param opts.hidden Mark step as hidden (excluded from SRT). Detected
 *   automatically if `text` contains `@hidden`.
 * @param opts.autoWait Pause the test after recording the step for the
 *   approximate time the narration takes to speak. Useful when running
 *   without TTS so the recorded video has natural visual time for the line.
 *   - `true` — estimate via non-whitespace characters / `NARRATE_DEFAULT_CPS`.
 *   - `number` — wait exactly this many milliseconds.
 *   - `{ charactersPerSecond, minMs, maxMs }` — tune the estimate.
 *   When omitted, the global default from `setupRecast({ narrateAutoWait })`
 *   applies. Pass `false` to disable the wait for this call regardless of the
 *   global default.
 */
export async function narrate(
  text: string | undefined,
  opts?: {
    hidden?: boolean
    autoWait?: NarrateAutoWait
  },
): Promise<void> {
  const hidden = opts?.hidden ?? text?.includes('@hidden') ?? false
  const cleanText = text?.replace(/@hidden\s*/g, '').trim() || ''

  // Always push annotations — even for empty/hidden steps — so external
  // reporters that map annotations to BDD steps by sequential index (the
  // legacy report.json contract) stay consistent. A `narrate(undefined,
  // {hidden:true})` call must still produce one voiceover + one
  // voiceover-hidden annotation, otherwise downstream highlight/zoom
  // annotations get attributed to the wrong step.
  const info = _getTestInfo()
  info.annotations.push({ type: 'voiceover', description: cleanText })
  info.annotations.push({
    type: 'voiceover-hidden',
    description: hidden ? '1' : '0',
  })

  // The trace marker step is only useful when there is text to record;
  // empty steps would just clutter the trace. `subtitlesFromTrace` skips
  // hidden markers anyway.
  if (cleanText && _step) {
    const prefix = hidden ? NARRATE_HIDDEN_TITLE_PREFIX : NARRATE_TITLE_PREFIX
    await _step(`${prefix}${cleanText}`, async () => {})
  }

  // A per-call autoWait (including an explicit `false`) overrides the global
  // default; omitting it falls back to setupRecast's narrateAutoWait.
  const autoWait = opts?.autoWait ?? _narrateAutoWait
  const waitMs = resolveAutoWait(cleanText, autoWait)
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
}

function resolveAutoWait(
  text: string,
  autoWait: NarrateAutoWait | undefined,
): number {
  if (!autoWait) return 0
  if (typeof autoWait === 'number') return Math.max(0, autoWait)
  const cps =
    (typeof autoWait === 'object' && autoWait.charactersPerSecond) || NARRATE_DEFAULT_CPS
  const minMs = (typeof autoWait === 'object' && autoWait.minMs) || 0
  const maxMs = typeof autoWait === 'object' ? autoWait.maxMs : undefined
  const estimated = estimateNarrationMs(text, cps)
  const clampedLow = Math.max(minMs, estimated)
  return maxMs !== undefined ? Math.min(maxMs, clampedLow) : clampedLow
}

/**
 * Zoom into a Playwright element during this step.
 * Gets the element's bounding box and stores relative coordinates as annotation.
 * The renderer applies crop+scale during this step's time window.
 *
 * @param locator Playwright Locator to zoom into
 * @param level Zoom level (1.0 = no zoom, 1.5 = 1.5x closer)
 */
export async function zoom(
  locator: Locator,
  level: number = 1.5,
): Promise<void> {
  const page = locator.page()
  const viewport = page.viewportSize()
  if (!viewport) return

  const box = await locator.boundingBox()
  if (!box) return

  const x = (box.x + box.width / 2) / viewport.width
  const y = (box.y + box.height / 2) / viewport.height
  const payload = { x, y, level }

  _getTestInfo().annotations.push({
    type: 'zoom',
    description: JSON.stringify(payload),
  })

  if (_step) {
    await _step(`${ZOOM_TITLE_PREFIX}${JSON.stringify(payload)}`, async () => {})
  }
}

/**
 * Highlight text in the demo video.
 *
 * - `highlight(locator)` — highlights the entire element
 * - `highlight(locator, { text: 'substring' })` — highlights only the matching text inside the element
 *
 * For input/textarea elements, the text option uses a temporary overlay measurement
 * since form elements don't expose text node bounding boxes.
 *
 * @param locator Playwright Locator pointing to the element containing the text
 * @param opts.text Specific text to highlight (substring). If omitted, highlights entire element.
 * @param opts.color Highlight color as hex '#RRGGBB' (default: '#FFEB3B' yellow)
 * @param opts.opacity Opacity 0.0–1.0 (default: 0.35)
 * @param opts.duration Visibility duration in ms (default: 3000)
 * @param opts.fadeOut Fade out duration in ms (default: 500)
 * @param opts.swipeDuration Swipe animation duration in ms (default: 300)
 */
export async function highlight(
  locator: Locator,
  opts?: {
    text?: string
    color?: string
    opacity?: number
    duration?: number
    fadeOut?: number
    swipeDuration?: number
  },
): Promise<void> {
  const { text, ...styleOpts } = opts ?? {}

  let box: { x: number; y: number; width: number; height: number } | null

  if (text) {
    // Measure bounding box of specific text inside the element.
    // Works for regular elements (via Range API) and input/textarea (via overlay measurement).
    box = await locator.evaluate((el, searchText) => {
      const isFormElement = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      if (isFormElement) {
        // For input/textarea: create a temporary mirror div to measure text position
        const value = el.value
        const idx = value.indexOf(searchText)
        if (idx === -1) return null

        const style = window.getComputedStyle(el)
        const mirror = document.createElement('div')
        // Copy relevant styles
        for (const prop of ['font', 'fontSize', 'fontFamily', 'fontWeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'padding', 'paddingLeft', 'paddingTop', 'paddingRight', 'border', 'boxSizing', 'whiteSpace', 'wordWrap', 'overflowWrap', 'lineHeight'] as const) {
          mirror.style.setProperty(prop, style.getPropertyValue(prop))
        }
        mirror.style.position = 'absolute'
        mirror.style.visibility = 'hidden'
        mirror.style.width = `${el.offsetWidth}px`
        mirror.style.whiteSpace = 'pre-wrap'

        const before = document.createTextNode(value.slice(0, idx))
        const mark = document.createElement('span')
        mark.textContent = searchText
        const after = document.createTextNode(value.slice(idx + searchText.length))
        mirror.append(before, mark, after)
        document.body.appendChild(mirror)

        const elRect = el.getBoundingClientRect()
        const markRect = mark.getBoundingClientRect()
        const mirrorRect = mirror.getBoundingClientRect()

        // Offset: mark position relative to mirror, then add element position
        const result = {
          x: elRect.left + (markRect.left - mirrorRect.left),
          y: elRect.top + (markRect.top - mirrorRect.top),
          width: markRect.width,
          height: markRect.height,
        }

        document.body.removeChild(mirror)
        return result
      }

      // For regular elements: use Range API to find text node and measure
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const content = node.textContent ?? ''
        const idx = content.indexOf(searchText)
        if (idx === -1) continue

        const range = document.createRange()
        range.setStart(node, idx)
        range.setEnd(node, idx + searchText.length)
        const rect = range.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      return null
    }, text)
  } else {
    box = await locator.boundingBox()
  }

  if (!box) return

  const payload = {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    ...styleOpts,
  }

  _getTestInfo().annotations.push({
    type: 'highlight',
    description: JSON.stringify(payload),
  })

  if (_step) {
    await _step(`${HIGHLIGHT_TITLE_PREFIX}${JSON.stringify(payload)}`, async () => {})
  }
}

/**
 * Ensure a demo step takes at least `ms` milliseconds.
 * Call at the END of a step to pad with a visual pause
 * so the video has enough time for voiceover narration.
 */
export async function pace(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms)
}
