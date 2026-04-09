import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { RecordOptions, RecordingResult } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..', '..')

/**
 * Record a browser session with tracing + video + DOM action tracking.
 *
 * Uses Playwright Test with page.pause() for trace/video capture,
 * plus an injected DOM tracking script that reports user interactions
 * (click, fill, press) back to Node.js via page.exposeFunction().
 *
 * The DOM-tracked actions are saved to _recorded-actions.json and can be
 * injected into the pipeline via injectActions() for hideSteps, clickEffect,
 * autoZoom, and cursorOverlay.
 */
export async function record(
  url: string,
  outputDir: string,
  options: RecordOptions,
): Promise<RecordingResult> {
  fs.mkdirSync(outputDir, { recursive: true })

  // Clean up artifacts from previous runs
  for (const f of fs.readdirSync(outputDir)) {
    if (f.endsWith('.webm') || f === 'trace.zip' || f === '_recorded-actions.json') {
      fs.unlinkSync(path.join(outputDir, f))
    }
  }

  const vw = options.viewport.width
  const vh = options.viewport.height

  // Dynamic import of playwright API
  const pw = await import(pathToFileURL(path.join(packageRoot, 'node_modules', 'playwright', 'index.mjs')).href)

  const browser = await pw.chromium.launch({ headless: false })

  const context = await browser.newContext({
    viewport: { width: vw, height: vh },
    ignoreHTTPSErrors: options.ignoreHttpsErrors,
    recordVideo: {
      dir: outputDir,
      size: { width: vw, height: vh },
    },
    ...(options.loadStorage
      ? { storageState: path.resolve(options.loadStorage) }
      : {}),
  })

  // Start tracing (captures screencast frames)
  await context.tracing.start({ screenshots: true, snapshots: true })

  const page = await context.newPage()

  // Accumulate actions on Node.js side (survives page navigations)
  const trackedActions: Array<{
    method: string
    selector: string
    value?: string
    x?: number
    y?: number
    timestamp: number
  }> = []

  // Expose a function that the page calls to report actions.
  // This persists across navigations — the bridge stays alive.
  await page.exposeFunction('__recastReportAction', (action: typeof trackedActions[number]) => {
    trackedActions.push(action)
  })

  // Inject event listeners. addInitScript runs on every new document,
  // but __recastReportAction sends data to Node.js so nothing is lost.
  await page.addInitScript(() => {
    function getSelector(el: Element): string {
      const role = el.getAttribute('role')
      const ariaLabel = el.getAttribute('aria-label')
      if (role && ariaLabel) return `[role="${role}"][aria-label="${ariaLabel}"]`

      const testId = el.getAttribute('data-testid')
      if (testId) return `[data-testid="${testId}"]`

      if (el.id) return `#${el.id}`

      const name = el.getAttribute('name')
      if (name) return `[name="${name}"]`

      const text = el.textContent?.trim().substring(0, 30)
      if (text) return `${el.tagName.toLowerCase()}:has-text("${text}")`

      return el.tagName.toLowerCase()
    }

    document.addEventListener('click', (e) => {
      const target = e.target as Element
      ;(window as any).__recastReportAction({
        method: 'click',
        selector: getSelector(target),
        x: e.clientX,
        y: e.clientY,
        timestamp: Date.now(),
      })
    }, true)

    document.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement
      ;(window as any).__recastReportAction({
        method: 'fill',
        selector: getSelector(target),
        value: target.type === 'password' ? '***' : target.value,
        timestamp: Date.now(),
      })
    }, true)

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
        const target = e.target as Element
        ;(window as any).__recastReportAction({
          method: 'press',
          selector: getSelector(target),
          value: e.key,
          timestamp: Date.now(),
        })
      }
    }, true)
  })

  // Track navigations
  page.on('framenavigated', (frame: any) => {
    if (frame === page.mainFrame()) {
      trackedActions.push({
        method: 'goto',
        selector: '',
        value: frame.url(),
        timestamp: Date.now(),
      })
    }
  })

  try {
    await page.goto(url, { timeout: 60_000, waitUntil: 'domcontentloaded' })
  } catch {
    // Navigation may fail (e.g., redirects), continue anyway
  }

  // Open Inspector — user interacts and clicks Resume when done
  await page.pause()

  // Stop tracing and save
  const tracePath = path.join(outputDir, 'trace.zip')
  await context.tracing.stop({ path: tracePath })

  // Get video path before closing
  const video = page.video()
  const videoPath = video ? await video.path() : ''

  await context.close()
  await browser.close()

  // Rename video to standard name
  const finalVideoPath = path.join(outputDir, 'video.webm')
  if (videoPath && fs.existsSync(videoPath) && videoPath !== finalVideoPath) {
    fs.renameSync(videoPath, finalVideoPath)
  }

  // Save tracked actions
  if (trackedActions.length > 0) {
    fs.writeFileSync(
      path.join(outputDir, '_recorded-actions.json'),
      JSON.stringify(trackedActions, null, 2),
    )
  }

  // Parse trace for stats
  let actionCount = trackedActions.length
  let durationMs = 0
  if (fs.existsSync(tracePath)) {
    try {
      const { parseTrace } = await import('../parse/trace-parser.js')
      const trace = await parseTrace(tracePath)
      if (trace.actions.length > actionCount) {
        actionCount = trace.actions.length
      }
      durationMs = (trace.metadata.endTime as number) - (trace.metadata.startTime as number)
      trace.frameReader.dispose()
    } catch {
      if (trackedActions.length > 1) {
        durationMs = trackedActions[trackedActions.length - 1]!.timestamp - trackedActions[0]!.timestamp
      }
    }
  }

  return {
    outputDir,
    tracePath,
    videoPath: fs.existsSync(finalVideoPath) ? finalVideoPath : '',
    actionCount,
    durationMs,
  }
}
