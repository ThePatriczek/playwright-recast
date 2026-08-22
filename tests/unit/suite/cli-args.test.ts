import { describe, it, expect } from 'vitest'
import {
  splitCommand,
  parseSuiteArgs,
  buildPlaywrightArgs,
} from '../../../src/suite/cli-args'

describe('splitCommand', () => {
  it('recognises render-suite', () => {
    expect(splitCommand(['render-suite', '-o', 'out.mp4']))
      .toEqual({ command: 'render-suite', rest: ['-o', 'out.mp4'] })
  })

  it('recognises test', () => {
    expect(splitCommand(['test', '--', '--project=chromium']))
      .toEqual({ command: 'test', rest: ['--', '--project=chromium'] })
  })

  it('falls back to the single-trace command when no subcommand is given', () => {
    expect(splitCommand(['-i', 'trace.zip', '-o', 'demo.mp4']))
      .toEqual({ command: 'render', rest: ['-i', 'trace.zip', '-o', 'demo.mp4'] })
  })

  it('does not treat a flag value as a subcommand', () => {
    expect(splitCommand(['--input', 'test']).command).toBe('render')
  })

  it('treats an empty argv as the single-trace command', () => {
    expect(splitCommand([])).toEqual({ command: 'render', rest: [] })
  })

  it('keeps --help with the single-trace command', () => {
    expect(splitCommand(['--help']).command).toBe('render')
  })
})

describe('parseSuiteArgs', () => {
  it('parses the render-suite flags', () => {
    expect(parseSuiteArgs(['--config', 'r.config.ts', '--manifest', 'm.json', '-o', 'out.mp4']))
      .toMatchObject({ config: 'r.config.ts', manifest: 'm.json', output: 'out.mp4' })
  })

  it('accepts --output as well as -o', () => {
    expect(parseSuiteArgs(['--output', 'out.mp4']).output).toBe('out.mp4')
  })

  it('leaves everything optional', () => {
    const parsed = parseSuiteArgs([])
    expect(parsed.config).toBeUndefined()
    expect(parsed.manifest).toBeUndefined()
    expect(parsed.output).toBeUndefined()
  })

  it('collects playwright passthrough args after --', () => {
    const parsed = parseSuiteArgs(['-o', 'out.mp4', '--', '--project=chromium', '--grep=@video'])
    expect(parsed.output).toBe('out.mp4')
    expect(parsed.passthrough).toEqual(['--project=chromium', '--grep=@video'])
  })

  it('returns no passthrough when -- is absent', () => {
    expect(parseSuiteArgs(['-o', 'out.mp4']).passthrough).toEqual([])
  })

  it('keeps a bare -- with nothing after it harmless', () => {
    expect(parseSuiteArgs(['--']).passthrough).toEqual([])
  })

  it('parses --keep-clips', () => {
    expect(parseSuiteArgs(['--keep-clips']).keepClips).toBe(true)
    expect(parseSuiteArgs([]).keepClips).toBe(false)
  })

  it('parses --inject-reporter', () => {
    expect(parseSuiteArgs(['--inject-reporter']).injectReporter).toBe(true)
    expect(parseSuiteArgs([]).injectReporter).toBe(false)
  })

  it('rejects an unknown flag', () => {
    expect(() => parseSuiteArgs(['--nope'])).toThrow(/nope/)
  })

  it('does not validate passthrough args', () => {
    expect(() => parseSuiteArgs(['--', '--nope'])).not.toThrow()
  })
})

describe('buildPlaywrightArgs', () => {
  it('runs playwright test with the passthrough args', () => {
    expect(buildPlaywrightArgs(['--project=chromium'], { injectReporter: false, reporterPath: '/r.js' }))
      .toEqual(['playwright', 'test', '--project=chromium'])
  })

  it('appends the recast reporter when injection is requested', () => {
    expect(buildPlaywrightArgs([], { injectReporter: true, reporterPath: '/r.js' }))
      .toEqual(['playwright', 'test', '--reporter=list,/r.js'])
  })

  it('does not inject when the caller passed their own --reporter', () => {
    expect(buildPlaywrightArgs(['--reporter=dot'], { injectReporter: true, reporterPath: '/r.js' }))
      .toEqual(['playwright', 'test', '--reporter=dot'])
  })

  it('does not inject over a space-separated --reporter', () => {
    expect(buildPlaywrightArgs(['--reporter', 'dot'], { injectReporter: true, reporterPath: '/r.js' }))
      .toEqual(['playwright', 'test', '--reporter', 'dot'])
  })
})
