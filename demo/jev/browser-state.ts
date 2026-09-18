import type { Page } from '@playwright/test'
import type { BrowserState } from './model.js'

export async function readBrowserState(page: Page, root: string): Promise<BrowserState> {
  const snapshot = await page.evaluate((rootSelector) => {
    const configuredScope = document.querySelector(rootSelector)
    if (!configuredScope) throw new Error(`Missing scenario root: ${rootSelector}`)
    const scope = [...configuredScope.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"]')]
      .find(dialog => dialog.checkVisibility()) || configuredScope
    document.querySelectorAll('[data-jev-ref]').forEach(element => element.removeAttribute('data-jev-ref'))
    const selector = 'button, a[href], input, textarea, select, [role="button"], [role="checkbox"], [role="switch"], [contenteditable="true"]'
    const controls = [...scope.querySelectorAll<HTMLElement>(selector)].flatMap((element, index) => {
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (!element.checkVisibility() || style.opacity === '0' || box.width <= 0 || box.height <= 0 || box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) return []
      const inputType = element instanceof HTMLInputElement ? element.type : element.getAttribute('type') || ''
      if (['password', 'hidden', 'file'].includes(inputType)) return []
      const labelIds = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
      const labelledText = labelIds.map(id => document.getElementById(id)?.textContent || '').join(' ').trim()
      const nativeLabels = element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
        ? [...element.labels || []].map(label => {
          const copy = label.cloneNode(true) as HTMLElement
          copy.querySelectorAll('input, select, textarea, button').forEach(control => control.remove())
          return copy.textContent
        }).join(' ')
        : ''
      const label = (element.getAttribute('aria-label') || labelledText || nativeLabels || element.getAttribute('placeholder') || element.innerText || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 180)
      if (!label) return []
      const tag = element.tagName.toLowerCase()
      const role = element.getAttribute('role') || tag
      const ref = `element_${index}`
      element.setAttribute('data-jev-ref', ref)
      const editable = element.isContentEditable || tag === 'textarea' || (tag === 'input' && ['', 'text', 'email', 'search', 'url', 'tel', 'number'].includes(inputType))
      return [{
        ref,
        tag,
        role,
        label,
        inputType,
        value: element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? element.value : element.isContentEditable ? element.innerText : '',
        checked: element instanceof HTMLInputElement ? element.checked : element.getAttribute('aria-checked') === 'true',
        enabled: !element.matches(':disabled, [aria-disabled="true"], [readonly]'),
        editable,
        options: element instanceof HTMLSelectElement ? [...element.options].map(option => ({ value: option.value, label: option.text, disabled: option.disabled })) : [],
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
      }]
    })
    return {
      text: (scope instanceof HTMLElement ? scope.innerText : scope.textContent || '').slice(0, 12_000),
      controls,
      scroll: { y: scrollY, max: Math.max(0, document.documentElement.scrollHeight - innerHeight), viewportHeight: innerHeight },
    }
  }, root)
  return { url: page.url(), title: await page.title(), ...snapshot }
}
