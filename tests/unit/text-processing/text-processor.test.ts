import { describe, it, expect } from 'vitest'
import { processText } from '../../../src/text-processing/text-processor'

describe('processText', () => {
  it('passes through text with empty config', () => {
    expect(processText('hello', {})).toBe('hello')
  })

  it('applies builtins when enabled', () => {
    expect(processText('\u201Etest\u201D', { builtins: true })).toBe('test')
  })

  it('does not apply builtins when explicitly false', () => {
    expect(processText('\u201Etest\u201D', { builtins: false })).toBe('\u201Etest\u201D')
  })

  it('applies string pattern rules', () => {
    expect(
      processText('NSS rozhodl', {
        rules: [{ pattern: '\\bNSS\\b', flags: 'g', replacement: 'Nejvy\u0161\u0161\u00ED spr\u00E1vn\u00ED soud' }],
      }),
    ).toBe('Nejvy\u0161\u0161\u00ED spr\u00E1vn\u00ED soud rozhodl')
  })

  it('applies RegExp pattern rules', () => {
    expect(
      processText('**bold** text', {
        rules: [{ pattern: /\*\*(.*?)\*\*/g, replacement: '$1' }],
      }),
    ).toBe('bold text')
  })

  it('defaults to g flag when flags omitted for string patterns', () => {
    expect(
      processText('a-b-c', {
        rules: [{ pattern: '-', replacement: '_' }],
      }),
    ).toBe('a_b_c')
  })

  it('applies custom transform function', () => {
    expect(
      processText('  hello  world  ', {
        transform: (t) => t.replace(/\s+/g, ' ').trim(),
      }),
    ).toBe('hello world')
  })

  it('applies all three layers in order: builtins -> rules -> transform', () => {
    const result = processText('\u201ENSS\u201D rozhodl', {
      builtins: true,
      rules: [{ pattern: '\\bNSS\\b', replacement: 'Nejvy\u0161\u0161\u00ED spr\u00E1vn\u00ED soud' }],
      transform: (t) => t.toUpperCase(),
    })
    expect(result).toBe('NEJVY\u0160\u0160\u00CD SPR\u00C1VN\u00CD SOUD ROZHODL')
  })

  it('applies multiple rules in order', () => {
    const result = processText('A then B', {
      rules: [
        { pattern: 'A', replacement: 'X' },
        { pattern: 'X', replacement: 'Y' },
      ],
    })
    expect(result).toBe('Y then B')
  })

  it('handles empty rules array', () => {
    expect(processText('text', { rules: [] })).toBe('text')
  })
})
