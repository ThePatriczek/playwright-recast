import type { Page, Locator, TestInfo } from '@playwright/test'

/**
 * Get current test info — works in both playwright-bdd and standard Playwright.
 * Must be called from within a test context.
 */
function getTestInfo(): TestInfo {
  // @playwright/test provides test.info() but we can't import 'test' generically.
  // Instead, we use the global __test_info__ or accept it as parameter.
  throw new Error(
    'getTestInfo() must be overridden. Call Recast.setup(test) first.',
  )
}

let _getTestInfo: () => TestInfo = getTestInfo

/**
 * Initialize playwright-recast helpers with the test instance.
 * Call once in your fixtures file:
 *
 * ```typescript
 * import { test } from 'playwright-bdd'
 * import { setupRecast } from '@workspace/playwright-recast/helpers'
 * setupRecast(test)
 * ```
 */
export function setupRecast(testInstance: { info: () => TestInfo }): void {
  _getTestInfo = () => testInstance.info()
}

/**
 * Attach voiceover narration text to the current step.
 * Call from EVERY step definition (even without doc string) so
 * the reporter can match annotations to steps by sequential index.
 *
 * @param text Doc string content (voiceover text). Pass undefined if none.
 * @param opts.hidden Mark step as hidden (not recorded, excluded from SRT)
 */
export function narrate(
  text: string | undefined,
  opts?: { hidden?: boolean },
): void {
  const hidden = opts?.hidden ?? text?.includes('@hidden') ?? false
  const cleanText = text?.replace(/@hidden\s*/g, '').trim() || ''

  const info = _getTestInfo()
  info.annotations.push({ type: 'voiceover', description: cleanText })
  info.annotations.push({
    type: 'voiceover-hidden',
    description: hidden ? '1' : '0',
  })
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

  _getTestInfo().annotations.push({
    type: 'zoom',
    description: JSON.stringify({ x, y, level }),
  })
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

  _getTestInfo().annotations.push({
    type: 'highlight',
    description: JSON.stringify({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      ...styleOpts,
    }),
  })
}

/**
 * Ensure a demo step takes at least `ms` milliseconds.
 * Call at the END of a step to pad with a visual pause
 * so the video has enough time for voiceover narration.
 */
export async function pace(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms)
}
