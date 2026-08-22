import * as path from 'node:path'
import { ffmpeg } from '../render/renderer.js'
import type {
  CardContent,
  ResolvedSuiteCardConfig,
  SuiteCardConfig,
  SuiteSummary,
  SuiteTest,
} from '../types/suite.js'

/**
 * Static cards for tests that have no clip of their own — failures, skips,
 * missing recordings — plus the closing summary.
 *
 * A card is HTML screenshotted by headless Chromium, then held as a still by
 * ffmpeg. HTML keeps the cards themeable and lets a project swap in its own
 * template without this module growing a styling API.
 */

const DEFAULT_CARD_DURATION_MS = 2500
const DEFAULT_BACKGROUND = '#0f1115'
const DEFAULT_COLOR = '#f5f7fa'
const DEFAULT_ACCENT = '#ff5f56'
const MAX_SUBTITLE_LENGTH = 200

export function resolveCardConfig(config: SuiteCardConfig = {}): ResolvedSuiteCardConfig {
  return {
    durationMs: config.durationMs ?? DEFAULT_CARD_DURATION_MS,
    background: config.background ?? DEFAULT_BACKGROUND,
    color: config.color ?? DEFAULT_COLOR,
    accent: config.accent ?? DEFAULT_ACCENT,
    ...(config.template ? { template: config.template } : {}),
  }
}

/** Trim an error message down to something a card can show legibly. */
function condenseMessage(message: string): string {
  const firstLine = message.split('\n')[0]!.trim()
  return firstLine.length > MAX_SUBTITLE_LENGTH
    ? firstLine.slice(0, MAX_SUBTITLE_LENGTH - 1) + '…'
    : firstLine
}

/**
 * Describe a test that gets a card instead of (or after) a clip.
 * A passing test reaching this point had no usable recording.
 */
export function cardContentForTest(test: SuiteTest): CardContent {
  if (test.status === 'skipped') {
    return { kind: 'skipped', title: test.title, subtitle: 'Skipped' }
  }

  if (test.status === 'passed') {
    return { kind: 'missing', title: test.title, subtitle: 'No recording available' }
  }

  const subtitle = test.errorMessage
    ? condenseMessage(test.errorMessage)
    : test.status === 'timedOut'
      ? 'Test timed out'
      : test.status === 'interrupted'
        ? 'Test interrupted'
        : 'Test failed'

  return { kind: 'failed', title: test.title, subtitle }
}

/** The closing card: suite name over the result tally. */
export function summaryCardContent(suiteName: string, summary: SuiteSummary): CardContent {
  const parts: string[] = []
  if (summary.passed > 0) parts.push(`${summary.passed} passed`)
  if (summary.failed > 0) parts.push(`${summary.failed} failed`)
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`)
  if (summary.flaky > 0) parts.push(`${summary.flaky} flaky`)

  return {
    kind: 'summary',
    title: suiteName,
    subtitle: parts.length > 0 ? parts.join(', ') : 'No tests',
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface CardSize {
  width: number
  height: number
}

/** Render a card to a full HTML document at the target resolution. */
export function buildCardHtml(
  card: CardContent,
  config: ResolvedSuiteCardConfig,
  size: CardSize,
): string {
  if (config.template) return config.template(card)

  // Scale type with the output height so a 720p card reads like a 1080p one.
  const scale = size.height / 1080
  const titleSize = Math.round(64 * scale)
  const subtitleSize = Math.round(32 * scale)
  const markerSize = Math.round(14 * scale)
  const gap = Math.round(28 * scale)

  const showsMarker = card.kind === 'failed'
  const marker = showsMarker
    ? `<div class="marker"></div>`
    : ''

  const subtitle = card.subtitle
    ? `<p class="subtitle">${escapeHtml(card.subtitle)}</p>`
    : ''

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${size.width}px;
    height: ${size.height}px;
    background: ${config.background};
    color: ${config.color};
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: ${gap}px;
    padding: 0 ${Math.round(size.width * 0.12)}px;
    text-align: center;
  }
  .marker {
    width: ${markerSize}px;
    height: ${markerSize}px;
    border-radius: 50%;
    background: ${config.accent};
  }
  .title {
    font-size: ${titleSize}px;
    font-weight: 600;
    line-height: 1.15;
    letter-spacing: -0.02em;
  }
  .subtitle {
    font-size: ${subtitleSize}px;
    font-weight: 400;
    line-height: 1.4;
    opacity: 0.62;
    max-width: 80%;
  }
</style>
</head>
<body>
  <div class="card">
    ${marker}
    <h1 class="title">${escapeHtml(card.title)}</h1>
    ${subtitle}
  </div>
</body>
</html>`
}

/**
 * Turn a screenshot into a still video clip of the configured length.
 * The clip carries a silent audio track so it concatenates with narrated
 * clips without a stream mismatch.
 */
export function stillClipFromImage(
  imagePath: string,
  durationMs: number,
  fps: number,
  outputPath: string,
): void {
  const seconds = Math.max(durationMs, 1) / 1000
  ffmpeg([
    '-y',
    '-loop', '1', '-t', seconds.toFixed(3), '-i', imagePath,
    '-f', 'lavfi', '-t', seconds.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest',
    outputPath,
  ])
}

/**
 * Renders cards to video clips, keeping one browser alive for the whole suite.
 * Chromium is launched lazily, so a run whose tests all produced clips never
 * starts a browser at all.
 */
export class CardRenderer {
  private browser: import('@playwright/test').Browser | undefined

  constructor(
    private readonly config: ResolvedSuiteCardConfig,
    private readonly size: CardSize,
    private readonly fps: number,
    private readonly tmpDir: string,
  ) {}

  async render(card: CardContent, label: string): Promise<string> {
    const browser = await this.ensureBrowser()
    const page = await browser.newPage({ viewport: this.size })
    const imagePath = path.join(this.tmpDir, `card-${label}.png`)

    try {
      await page.setContent(buildCardHtml(card, this.config, this.size), {
        waitUntil: 'load',
      })
      await page.screenshot({ path: imagePath })
    } finally {
      await page.close()
    }

    const clipPath = path.join(this.tmpDir, `card-${label}.mp4`)
    stillClipFromImage(imagePath, this.config.durationMs, this.fps, clipPath)
    return clipPath
  }

  async close(): Promise<void> {
    await this.browser?.close()
    this.browser = undefined
  }

  private async ensureBrowser(): Promise<import('@playwright/test').Browser> {
    if (this.browser) return this.browser
    let chromium: typeof import('@playwright/test').chromium
    try {
      ({ chromium } = await import('@playwright/test'))
    } catch {
      throw new Error(
        'Rendering suite cards needs @playwright/test installed. ' +
        'Install it, or disable cards with results: { failures: "omit", skipped: "omit", summary: false }.',
      )
    }
    this.browser = await chromium.launch()
    return this.browser
  }
}
