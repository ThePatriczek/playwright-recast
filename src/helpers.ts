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
 * Ensure a demo step takes at least `ms` milliseconds.
 * Call at the END of a step to pad with a visual pause
 * so the video has enough time for voiceover narration.
 */
export async function pace(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms)
}
