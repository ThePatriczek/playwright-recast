import { describe, it, expect } from 'vitest'
import {
  parseManifest,
  computeSummary,
  sortByDeclarationOrder,
  filterTests,
} from '../../../src/suite/manifest'
import type { SuiteTest } from '../../../src/types/suite'

function makeTest(overrides: Partial<SuiteTest> = {}): SuiteTest {
  return {
    id: 'abc',
    title: 'creates a project',
    titlePath: ['spec.ts', 'creates a project'],
    order: 0,
    tags: [],
    status: 'passed',
    retry: 0,
    durationMs: 1200,
    ...overrides,
  }
}

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    const manifest = parseManifest({
      version: 1,
      createdAt: '2026-08-22T10:00:00.000Z',
      tests: [makeTest()],
      summary: { passed: 1, failed: 0, skipped: 0, flaky: 0 },
      exitCode: 0,
    })
    expect(manifest.tests).toHaveLength(1)
    expect(manifest.tests[0]?.title).toBe('creates a project')
  })

  it('names the offending field when a required key is missing', () => {
    expect(() => parseManifest({ version: 1, tests: [] }))
      .toThrow(/createdAt/)
  })

  it('rejects an unknown manifest version', () => {
    expect(() => parseManifest({
      version: 2,
      createdAt: '2026-08-22T10:00:00.000Z',
      tests: [],
      summary: { passed: 0, failed: 0, skipped: 0, flaky: 0 },
      exitCode: 0,
    })).toThrow(/version/)
  })

  it('rejects an unknown test status', () => {
    expect(() => parseManifest({
      version: 1,
      createdAt: '2026-08-22T10:00:00.000Z',
      tests: [{ ...makeTest(), status: 'exploded' }],
      summary: { passed: 0, failed: 0, skipped: 0, flaky: 0 },
      exitCode: 0,
    })).toThrow(/status/)
  })
})

describe('sortByDeclarationOrder', () => {
  it('orders by declaration index, not result order', () => {
    const sorted = sortByDeclarationOrder([
      makeTest({ id: 'c', order: 2 }),
      makeTest({ id: 'a', order: 0 }),
      makeTest({ id: 'b', order: 1 }),
    ])
    expect(sorted.map(t => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the input array', () => {
    const input = [makeTest({ id: 'b', order: 1 }), makeTest({ id: 'a', order: 0 })]
    sortByDeclarationOrder(input)
    expect(input.map(t => t.id)).toEqual(['b', 'a'])
  })
})

describe('computeSummary', () => {
  it('counts each outcome', () => {
    const summary = computeSummary([
      makeTest({ status: 'passed' }),
      makeTest({ status: 'failed' }),
      makeTest({ status: 'timedOut' }),
      makeTest({ status: 'skipped' }),
    ])
    expect(summary).toEqual({ passed: 1, failed: 2, skipped: 1, flaky: 0 })
  })

  it('counts a test that passed on retry as flaky and as passed', () => {
    const summary = computeSummary([makeTest({ status: 'passed', retry: 1 })])
    expect(summary.passed).toBe(1)
    expect(summary.flaky).toBe(1)
  })

  it('does not count a failing retry as flaky', () => {
    const summary = computeSummary([makeTest({ status: 'failed', retry: 2 })])
    expect(summary.flaky).toBe(0)
    expect(summary.failed).toBe(1)
  })

  it('treats interrupted tests as failed', () => {
    expect(computeSummary([makeTest({ status: 'interrupted' })]).failed).toBe(1)
  })
})

describe('filterTests', () => {
  const tests = [
    makeTest({ id: 'a', title: 'creates a project', tags: ['@video'], order: 0 }),
    makeTest({ id: 'b', title: 'deletes a project', tags: [], order: 1 }),
    makeTest({ id: 'c', title: 'invites a user', tags: ['@video', '@slow'], project: 'firefox', order: 2 }),
  ]

  it('returns everything when no filter is given', () => {
    expect(filterTests(tests, {})).toHaveLength(3)
  })

  it('matches a regex against the title', () => {
    expect(filterTests(tests, { grep: /project/ }).map(t => t.id)).toEqual(['a', 'b'])
  })

  it('matches a regex against tags', () => {
    expect(filterTests(tests, { grep: /@video/ }).map(t => t.id)).toEqual(['a', 'c'])
  })

  it('filters by project name', () => {
    expect(filterTests(tests, { project: 'firefox' }).map(t => t.id)).toEqual(['c'])
  })

  it('combines grep and project as AND', () => {
    expect(filterTests(tests, { grep: /@video/, project: 'firefox' }).map(t => t.id)).toEqual(['c'])
  })

  it('preserves declaration order', () => {
    const shuffled = [tests[2]!, tests[0]!, tests[1]!]
    expect(filterTests(shuffled, { grep: /@video/ }).map(t => t.id)).toEqual(['a', 'c'])
  })
})
