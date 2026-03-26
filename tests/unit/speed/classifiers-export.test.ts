import { describe, it, expect } from 'vitest'
import { USER_ACTION_METHODS } from '../../../src/speed/classifiers'

describe('USER_ACTION_METHODS export', () => {
  it('is exported and is a Set', () => {
    expect(USER_ACTION_METHODS).toBeInstanceOf(Set)
  })

  it('contains expected user interaction methods', () => {
    const expected = [
      'click', 'dblclick', 'fill', 'type', 'press',
      'check', 'uncheck', 'selectOption', 'setInputFiles',
      'hover', 'tap', 'dragTo',
    ]
    for (const method of expected) {
      expect(USER_ACTION_METHODS.has(method)).toBe(true)
    }
  })

  it('does not contain navigation methods', () => {
    const navMethods = ['goto', 'goBack', 'goForward', 'reload']
    for (const method of navMethods) {
      expect(USER_ACTION_METHODS.has(method)).toBe(false)
    }
  })

  it('does not contain wait methods', () => {
    const waitMethods = ['waitForSelector', 'waitForTimeout', 'waitForNavigation']
    for (const method of waitMethods) {
      expect(USER_ACTION_METHODS.has(method)).toBe(false)
    }
  })
})
