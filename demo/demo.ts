import { chromium } from '@playwright/test'
import * as path from 'node:path'
import * as fs from 'node:fs'

const OUTPUT_DIR = path.resolve(__dirname, 'output')

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    recordVideo: {
      dir: OUTPUT_DIR,
      size: { width: 1920, height: 1080 },
    },
  })

  await context.tracing.start({ screenshots: true, snapshots: true })
  const page = await context.newPage()

  // Step 1: Navigate to Google
  await page.goto('https://www.google.com')
  await page.waitForTimeout(2000)

  // Handle cookie consent
  try {
    await page.click('button:has-text("Accept all"), button:has-text("I agree"), button:has-text("Souhlasím"), #L2AGLb', { timeout: 5000 })
    await page.waitForTimeout(1000)
  } catch {
    // No cookie dialog
  }

  // Step 2: Type search query
  await page.locator('textarea[name="q"], input[name="q"]').first().click({ force: true })
  await page.waitForTimeout(500)
  await page.keyboard.type('Playwright browser automation framework', { delay: 50 })
  await page.waitForTimeout(2000)

  // Step 3: Submit search
  await page.keyboard.press('Enter')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(3000)

  // Step 4: Click first organic result
  try {
    await page.locator('h3').first().click({ timeout: 5000 })
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(4000)
  } catch {
    await page.waitForTimeout(3000)
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
  console.log(`  Trace: ${path.join(OUTPUT_DIR, 'trace.zip')}`)
  console.log(`  Video: ${path.join(OUTPUT_DIR, 'recording.webm')}`)
}

main().catch(console.error)
