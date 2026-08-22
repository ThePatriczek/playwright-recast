import { describe, it, expect } from 'vitest'
import { planSuite, resolveResultPolicy } from '../../../src/suite/plan'
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
    tracePath: '/runs/a/trace.zip',
    ...overrides,
  }
}

const summary = { passed: 0, failed: 0, skipped: 0, flaky: 0 }

describe('resolveResultPolicy', () => {
  it('applies defaults', () => {
    expect(resolveResultPolicy()).toEqual({
      failures: 'card',
      skipped: 'card',
      missingTrace: 'card',
      summary: true,
    })
  })

  it('preserves overrides', () => {
    const policy = resolveResultPolicy({ failures: 'omit', summary: false })
    expect(policy.failures).toBe('omit')
    expect(policy.summary).toBe(false)
    expect(policy.skipped).toBe('card')
  })
})

describe('planSuite', () => {
  it('emits one clip per passing test with a trace', () => {
    const plan = planSuite(
      [makeTest({ id: 'a', order: 0 }), makeTest({ id: 'b', order: 1 })],
      resolveResultPolicy({ summary: false }),
      'Suite', summary,
    )
    expect(plan).toHaveLength(2)
    expect(plan.every(item => item.kind === 'clip')).toBe(true)
  })

  it('keeps declaration order', () => {
    const plan = planSuite(
      [makeTest({ id: 'b', order: 1 }), makeTest({ id: 'a', order: 0 })],
      resolveResultPolicy({ summary: false }),
      'Suite', summary,
    )
    expect(plan.map(i => i.kind === 'clip' && i.test.id)).toEqual(['a', 'b'])
  })

  it('appends a summary card by default', () => {
    const plan = planSuite([makeTest()], resolveResultPolicy(), 'Product walkthrough', {
      passed: 1, failed: 0, skipped: 0, flaky: 0,
    })
    const last = plan[plan.length - 1]!
    expect(last.kind).toBe('card')
    expect(last.kind === 'card' && last.card.kind).toBe('summary')
    expect(last.kind === 'card' && last.card.title).toBe('Product walkthrough')
  })

  it('omits the summary card when disabled', () => {
    const plan = planSuite([makeTest()], resolveResultPolicy({ summary: false }), 'Suite', summary)
    expect(plan.some(i => i.kind === 'card' && i.card.kind === 'summary')).toBe(false)
  })

  describe('failed tests', () => {
    const failed = makeTest({ status: 'failed', errorMessage: 'boom' })

    it('renders a card by default', () => {
      const plan = planSuite([failed], resolveResultPolicy({ summary: false }), 'S', summary)
      expect(plan).toHaveLength(1)
      expect(plan[0]!.kind).toBe('card')
    })

    it('renders only the clip under the clip policy', () => {
      const plan = planSuite([failed], resolveResultPolicy({ failures: 'clip', summary: false }), 'S', summary)
      expect(plan.map(i => i.kind)).toEqual(['clip'])
    })

    it('renders clip then card under clip+card', () => {
      const plan = planSuite([failed], resolveResultPolicy({ failures: 'clip+card', summary: false }), 'S', summary)
      expect(plan.map(i => i.kind)).toEqual(['clip', 'card'])
    })

    it('drops the test entirely under omit', () => {
      const plan = planSuite([failed], resolveResultPolicy({ failures: 'omit', summary: false }), 'S', summary)
      expect(plan).toHaveLength(0)
    })

    it('falls back to a card when a clip policy has no trace to render', () => {
      const plan = planSuite(
        [makeTest({ status: 'failed', tracePath: undefined })],
        resolveResultPolicy({ failures: 'clip', summary: false }), 'S', summary,
      )
      expect(plan.map(i => i.kind)).toEqual(['card'])
    })

    it('applies the failure policy to timed-out tests', () => {
      const plan = planSuite(
        [makeTest({ status: 'timedOut' })],
        resolveResultPolicy({ failures: 'omit', summary: false }), 'S', summary,
      )
      expect(plan).toHaveLength(0)
    })
  })

  describe('skipped tests', () => {
    const skipped = makeTest({ status: 'skipped', tracePath: undefined })

    it('renders a card by default', () => {
      const plan = planSuite([skipped], resolveResultPolicy({ summary: false }), 'S', summary)
      expect(plan.map(i => i.kind)).toEqual(['card'])
      expect(plan[0]!.kind === 'card' && plan[0]!.card.kind).toBe('skipped')
    })

    it('is dropped under omit', () => {
      const plan = planSuite([skipped], resolveResultPolicy({ skipped: 'omit', summary: false }), 'S', summary)
      expect(plan).toHaveLength(0)
    })

    it('never renders a clip even when a trace exists', () => {
      const plan = planSuite(
        [makeTest({ status: 'skipped', tracePath: '/runs/x/trace.zip' })],
        resolveResultPolicy({ summary: false }), 'S', summary,
      )
      expect(plan.map(i => i.kind)).toEqual(['card'])
    })
  })

  describe('passing tests without a trace', () => {
    const noTrace = makeTest({ tracePath: undefined })

    it('renders a placeholder card by default', () => {
      const plan = planSuite([noTrace], resolveResultPolicy({ summary: false }), 'S', summary)
      expect(plan.map(i => i.kind)).toEqual(['card'])
      expect(plan[0]!.kind === 'card' && plan[0]!.card.kind).toBe('missing')
    })

    it('is dropped under omit', () => {
      const plan = planSuite(
        [noTrace], resolveResultPolicy({ missingTrace: 'omit', summary: false }), 'S', summary,
      )
      expect(plan).toHaveLength(0)
    })
  })

  it('labels every item uniquely so temp files never collide', () => {
    const plan = planSuite(
      [
        makeTest({ id: 'a', order: 0, status: 'failed' }),
        makeTest({ id: 'b', order: 1 }),
      ],
      resolveResultPolicy({ failures: 'clip+card' }), 'S', summary,
    )
    const labels = plan.map(i => i.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})
