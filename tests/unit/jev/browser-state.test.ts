import { chromium, type Browser, type Page } from '@playwright/test'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readBrowserState } from '../../../demo/jev/browser-state.js'

describe('readBrowserState()', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
  })

  beforeEach(async () => {
    page = await browser.newPage()
  })

  afterEach(async () => {
    await page?.close()
  })

  it.each(['password', 'PASSWORD', 'PaSsWoRd', 'file', 'FILE', 'FiLe'])(
    'excludes sensitive input type="%s" from browser state',
    async (type) => {
      await page.setContent(`
        <main id="scenario">
          <input type="text" aria-label="Name" value="Ada">
          <input id="sensitive" type="${type}" aria-label="Sensitive input">
        </main>
      `)
      const secret = type.toLowerCase() === 'file' ? 'synthetic-private.txt' : 'synthetic-password'
      if (type.toLowerCase() === 'file') {
        await page.locator('#sensitive').setInputFiles({
          name: secret,
          mimeType: 'text/plain',
          buffer: Buffer.from('Synthetic private file content'),
        })
      } else {
        await page.locator('#sensitive').fill(secret)
      }

      const state = await readBrowserState(page, '#scenario')

      expect(JSON.stringify(state)).not.toContain(secret)
      expect(state.controls).toHaveLength(1)
      expect(state.controls[0]).toMatchObject({
        tag: 'input',
        label: 'Name',
        inputType: 'text',
        value: 'Ada',
        editable: true,
      })
      expect(await page.locator('#sensitive').getAttribute('data-jev-ref')).toBeNull()
    },
  )
})
