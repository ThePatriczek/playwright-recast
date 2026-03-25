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
    colorScheme: 'light',
    recordVideo: {
      dir: OUTPUT_DIR,
      size: { width: 1920, height: 1080 },
    },
  })

  await context.tracing.start({ screenshots: true, snapshots: true })
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })

  // Step 1: Navigate to Playwright homepage
  await page.goto('https://playwright.dev/')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(4000)

  // Step 2: Click "Get started" button
  await page.locator('a:has-text("Get started")').first().click()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(4000)

  // Step 3: Click on "Writing tests" in the sidebar
  await page.locator('a:has-text("Writing tests")').first().click()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(4500)

  // Step 4: Scroll down to see code examples
  await page.mouse.wheel(0, 600)
  await page.waitForTimeout(4500)

  // Step 5: Click "Generating tests" in sidebar
  await page.locator('a:has-text("Generating tests")').first().click()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(6000)

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
