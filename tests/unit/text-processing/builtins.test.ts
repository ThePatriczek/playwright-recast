import { describe, it, expect } from 'vitest'
import { applyBuiltins, BUILTIN_RULES } from '../../../src/text-processing/builtins'

describe('BUILTIN_RULES', () => {
  it('is non-empty', () => {
    expect(BUILTIN_RULES.length).toBeGreaterThan(0)
  })
})

describe('applyBuiltins', () => {
  it('removes Czech curly double quotes', () => {
    expect(applyBuiltins('Vybereme \u201ESledovanou judikaturu\u201D pro monitoring'))
      .toBe('Vybereme Sledovanou judikaturu pro monitoring')
  })

  it('removes ASCII double quotes', () => {
    expect(applyBuiltins('dovednost "Sledovan\u00E1 judikatura" pro'))
      .toBe('dovednost Sledovan\u00E1 judikatura pro')
  })

  it('removes mixed curly-opening + ASCII-closing quotes', () => {
    expect(applyBuiltins('Vybereme \u201ESledovanou judikaturu" pro monitoring'))
      .toBe('Vybereme Sledovanou judikaturu pro monitoring')
  })

  it('removes curly single quotes', () => {
    expect(applyBuiltins('It\u2019s a \u201Atest\u201B')).toBe('Its a test')
  })

  it('removes guillemets', () => {
    expect(applyBuiltins('\u00ABBonjour\u00BB \u00ABmonde\u00BB')).toBe('Bonjour monde')
  })

  it('replaces em dash with comma + space', () => {
    expect(applyBuiltins('Zadat t\u00E9ma \u2014 okam\u017Eit\u00E9'))
      .toBe('Zadat t\u00E9ma, okam\u017Eit\u00E9')
  })

  it('replaces en dash with comma + space', () => {
    expect(applyBuiltins('Zadat t\u00E9ma \u2013 okam\u017Eit\u00E9 zru\u0161en\u00ED'))
      .toBe('Zadat t\u00E9ma, okam\u017Eit\u00E9 zru\u0161en\u00ED')
  })

  it('replaces horizontal ellipsis with three dots', () => {
    expect(applyBuiltins('\u010Cek\u00E1me\u2026 na v\u00FDsledek'))
      .toBe('\u010Cek\u00E1me... na v\u00FDsledek')
  })

  it('replaces non-breaking space with regular space', () => {
    expect(applyBuiltins('10\u00A0000\u00A0K\u010D')).toBe('10 000 K\u010D')
  })

  it('collapses multiple spaces', () => {
    expect(applyBuiltins('too   many    spaces')).toBe('too many spaces')
  })

  it('trims whitespace', () => {
    expect(applyBuiltins('  padded text  ')).toBe('padded text')
  })

  it('handles combined real Czech subtitle text', () => {
    expect(
      applyBuiltins('Vybereme \u201ESledovanou judikaturu\u201D \u2013 speci\u00E1ln\u00ED funkci\u2026'),
    ).toBe('Vybereme Sledovanou judikaturu, speci\u00E1ln\u00ED funkci...')
  })

  it('passes through plain ASCII text unchanged', () => {
    expect(applyBuiltins('Hello world')).toBe('Hello world')
  })

  it('handles empty string', () => {
    expect(applyBuiltins('')).toBe('')
  })
})
