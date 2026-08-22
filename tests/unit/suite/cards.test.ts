import { describe, it, expect } from 'vitest'
import {
  resolveCardConfig,
  buildCardHtml,
  cardContentForTest,
  summaryCardContent,
} from '../../../src/suite/cards'
import type { SuiteTest } from '../../../src/types/suite'

function makeTest(overrides: Partial<SuiteTest> = {}): SuiteTest {
  return {
    id: 'a',
    title: 'creates a project',
    titlePath: ['spec.ts', 'creates a project'],
    order: 0,
    tags: [],
    status: 'passed',
    retry: 0,
    durationMs: 1000,
    ...overrides,
  }
}

describe('resolveCardConfig', () => {
  it('applies defaults', () => {
    const resolved = resolveCardConfig()
    expect(resolved.durationMs).toBe(2500)
    expect(resolved.background).toBe('#0f1115')
    expect(resolved.color).toBe('#f5f7fa')
    expect(resolved.accent).toBe('#ff5f56')
  })

  it('preserves overrides', () => {
    const resolved = resolveCardConfig({ durationMs: 1000, background: '#fff' })
    expect(resolved.durationMs).toBe(1000)
    expect(resolved.background).toBe('#fff')
    expect(resolved.color).toBe('#f5f7fa')
  })

  it('allows a duration of zero', () => {
    expect(resolveCardConfig({ durationMs: 0 }).durationMs).toBe(0)
  })
})

describe('cardContentForTest', () => {
  it('describes a failed test with its error message', () => {
    const card = cardContentForTest(
      makeTest({ status: 'failed', errorMessage: 'Expected 1 to be 2' }),
    )
    expect(card.kind).toBe('failed')
    expect(card.title).toBe('creates a project')
    expect(card.subtitle).toBe('Expected 1 to be 2')
  })

  it('falls back to a generic subtitle when there is no error message', () => {
    const card = cardContentForTest(makeTest({ status: 'failed' }))
    expect(card.subtitle).toBe('Test failed')
  })

  it('labels a timeout distinctly', () => {
    const card = cardContentForTest(makeTest({ status: 'timedOut' }))
    expect(card.kind).toBe('failed')
    expect(card.subtitle).toBe('Test timed out')
  })

  it('describes a skipped test', () => {
    const card = cardContentForTest(makeTest({ status: 'skipped' }))
    expect(card.kind).toBe('skipped')
    expect(card.subtitle).toBe('Skipped')
  })

  it('describes a passing test with no trace as missing', () => {
    const card = cardContentForTest(makeTest({ status: 'passed' }))
    expect(card.kind).toBe('missing')
    expect(card.subtitle).toBe('No recording available')
  })

  it('truncates a very long error message', () => {
    const card = cardContentForTest(makeTest({
      status: 'failed',
      errorMessage: 'x'.repeat(500),
    }))
    expect(card.subtitle!.length).toBeLessThanOrEqual(200)
    expect(card.subtitle!.endsWith('…')).toBe(true)
  })

  it('keeps only the first line of a multi-line error', () => {
    const card = cardContentForTest(makeTest({
      status: 'failed',
      errorMessage: 'Expected 1 to be 2\n  at foo.spec.ts:12\n  at bar',
    }))
    expect(card.subtitle).toBe('Expected 1 to be 2')
  })
})

describe('summaryCardContent', () => {
  it('renders the tally', () => {
    const card = summaryCardContent('Product walkthrough', {
      passed: 3, failed: 1, skipped: 1, flaky: 0,
    })
    expect(card.kind).toBe('summary')
    expect(card.title).toBe('Product walkthrough')
    expect(card.subtitle).toBe('3 passed, 1 failed, 1 skipped')
  })

  it('omits zero counts', () => {
    const card = summaryCardContent('Suite', { passed: 4, failed: 0, skipped: 0, flaky: 0 })
    expect(card.subtitle).toBe('4 passed')
  })

  it('mentions flaky tests when there were any', () => {
    const card = summaryCardContent('Suite', { passed: 2, failed: 0, skipped: 0, flaky: 1 })
    expect(card.subtitle).toBe('2 passed, 1 flaky')
  })

  it('says so when nothing ran', () => {
    const card = summaryCardContent('Suite', { passed: 0, failed: 0, skipped: 0, flaky: 0 })
    expect(card.subtitle).toBe('No tests')
  })
})

describe('buildCardHtml', () => {
  const config = resolveCardConfig()
  const size = { width: 1920, height: 1080 }

  it('embeds the title and subtitle', () => {
    const html = buildCardHtml(
      { kind: 'failed', title: 'creates a project', subtitle: 'Expected 1 to be 2' },
      config, size,
    )
    expect(html).toContain('creates a project')
    expect(html).toContain('Expected 1 to be 2')
  })

  it('escapes html in user-supplied text', () => {
    const html = buildCardHtml(
      { kind: 'failed', title: '<script>alert(1)</script>', subtitle: 'a & b' },
      config, size,
    )
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('a &amp; b')
  })

  it('uses the configured colors', () => {
    const html = buildCardHtml(
      { kind: 'summary', title: 'Suite' },
      resolveCardConfig({ background: '#123456', color: '#abcdef' }),
      size,
    )
    expect(html).toContain('#123456')
    expect(html).toContain('#abcdef')
  })

  it('sizes the document to the target resolution', () => {
    const html = buildCardHtml({ kind: 'summary', title: 'Suite' }, config, { width: 1280, height: 720 })
    expect(html).toContain('1280px')
    expect(html).toContain('720px')
  })

  it('renders without a subtitle', () => {
    const html = buildCardHtml({ kind: 'summary', title: 'Suite' }, config, size)
    expect(html).toContain('Suite')
    expect(html).not.toContain('undefined')
  })

  it('delegates to a custom template when one is configured', () => {
    const html = buildCardHtml(
      { kind: 'summary', title: 'Suite' },
      resolveCardConfig({ template: card => `<html>custom:${card.title}</html>` }),
      size,
    )
    expect(html).toBe('<html>custom:Suite</html>')
  })
})
