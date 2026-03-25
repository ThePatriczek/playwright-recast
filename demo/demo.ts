import { chromium } from '@playwright/test'
import * as path from 'node:path'
import * as fs from 'node:fs'

const OUTPUT_DIR = path.resolve(__dirname, 'output')

async function main() {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  })

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    colorScheme: 'light',
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

  // Step 1: Navigate to Google homepage
  await page.goto('https://www.google.com/?hl=en')
  await page.waitForTimeout(1500)

  // Accept cookies — try multiple selectors
  try {
    const acceptBtn = page.locator('button').filter({ hasText: /Accept all|I agree|Přijmout/i }).first()
    await acceptBtn.waitFor({ state: 'visible', timeout: 5000 })
    await acceptBtn.click()
    await page.waitForTimeout(1500)
  } catch {
    // Try ID-based selector as fallback
    try {
      await page.click('#L2AGLb', { timeout: 2000 })
      await page.waitForTimeout(1500)
    } catch {
      // No dialog
    }
  }

  await page.waitForTimeout(1500)

  // Step 2: Click search box and type query
  await page.locator('textarea[name="q"], input[name="q"]').first().click({ force: true })
  await page.waitForTimeout(500)
  await page.keyboard.type('Playwright browser automation framework', { delay: 50 })
  await page.waitForTimeout(2500)

  // Step 3: Submit search
  await page.keyboard.press('Enter')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(3500)

  // Step 4: Click first organic result
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
