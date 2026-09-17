import { describe, expect, it } from 'vitest'
import { detectChanges, parseOcrRegions } from '../../../src/director/observers/video.js'
import { validateObservations } from '../../../src/director/renderer.js'

describe('video evidence', () => {
  it('groups recognized words into a readable region with normalized coordinates', () => {
    const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n' +
      '5\t1\t1\t1\t1\t1\t100\t50\t80\t20\t95\tPayment\n' +
      '5\t1\t1\t1\t1\t2\t190\t50\t60\t20\t93\tfailed\n' +
      '5\t1\t2\t1\t1\t1\t300\t50\t60\t20\t12\tNoise\n'
    const regions = parseOcrRegions(tsv, 500, 250)
    expect(regions).toHaveLength(1)
    expect(regions[0]).toMatchObject({ text: 'Payment failed', x: 0.2, y: 0.2, width: 0.3, height: 0.08000000000000002 })
    expect(parseOcrRegions(tsv, 500, 250)[0].id).toBe(regions[0].id)
  })

  it('localizes a changed panel from actual image samples without a DOM target', () => {
    const before = Buffer.alloc(320 * 180, 20)
    const after = Buffer.from(before)
    for (let y = 60; y < 100; y++) for (let x = 200; x < 280; x++) after[y * 320 + x] = 180
    const result = detectChanges(before, after)
    expect(result.fraction).toBeCloseTo(3200 / (320 * 180))
    expect(result.regions).toHaveLength(1)
    expect(result.regions[0]).toMatchObject({ x: 200 / 320, y: 60 / 180, width: 80 / 320, changed: true, kind: 'change' })
    expect(detectChanges(after, after)).toEqual({ fraction: 0, regions: [] })
  })

  it('rejects malformed evidence before it can become camera coordinates', () => {
    expect(() => validateObservations([{ atMs: 500, regions: [], changeFraction: 0 }], 2000, 20)).toThrow('start at zero')
    expect(() => validateObservations([{ atMs: 0, regions: [{ id: 'bad', text: '', kind: 'text', changed: true, x: 0.9, y: 0, width: 0.4, height: 0.1 }], changeFraction: 0 }], 2000, 20)).toThrow('Region leaves')
    expect(() => validateObservations([{ atMs: 0, regions: [], changeFraction: 0 }, { atMs: 0, regions: [], changeFraction: 0 }], 2000, 20)).toThrow('strictly increase')
  })
})
