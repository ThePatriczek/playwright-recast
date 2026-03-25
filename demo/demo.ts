import { chromium } from '@playwright/test'
import * as path from 'node:path'
import * as fs from 'node:fs'

const OUTPUT_DIR = path.resolve(__dirname, 'output')

async function main() {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  // Use headed mode with slowMo — more natural, avoids bot detection
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ],
  })

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    recordVideo: {
      dir: OUTPUT_DIR,
      size: { width: 1920, height: 1080 },
    },
  })

  await context.tracing.start({ screenshots: true, snapshots: true })
  const page = await context.newPage()

  // Navigate to Google in English
  await page.goto('https://www.google.com/search?hl=en&q=Playwright+browser+automation+framework')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)

  // Accept cookies if dialog appears
  try {
    await page.click('button:has-text("Accept all")', { timeout: 3000 })
    await page.waitForTimeout(1500)
  } catch {
    // No dialog
  }

  await page.waitForTimeout(3000)

  // Click first organic result
  try {
    await page.locator('h3').first().click({ timeout: 5000 })
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(5000)
  } catch {
    await page.waitForTimeout(4000)
  }

  // Stop tracing
  await context.tracing.stop({ path: path.join(OUTPUT_DIR, 'trace.zip') })
  await context.close()
  await browser.close()

  // Rename video
  const files = fs.readdirSync(OUTPUT_DIR)
  const webm = files.find(f => f.endsWith('.webm'))
  if (webm && webm !== 'recording.webm') {
    fs.renameSync(path.join(OUTPUT_DIR, webm), path.join(OUTPUT_DIR, 'recording.webm'))
  }

  console.log('Demo recorded!')
}

main().catch(console.error)
