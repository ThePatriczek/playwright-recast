import { describe, it, expect } from 'vitest'
import { buildUrlBarCues, formatUrl, urlAt } from '../../../src/url-bar/url-bar-events'
import type { PageUrl } from '../../../src/types/trace'
import { toMonotonic } from '../../../src/types/trace'

const url = (pageId: string, u: string, t: number): PageUrl => ({ pageId, url: u, timestamp: toMonotonic(t) })

describe('formatUrl', () => {
  it('never shows credentials in the authority', () => {
    expect(formatUrl('https://admin:s3cret@staging.example.com/x', { stripQuery: false })).toBe('https://staging.example.com/x')
    expect(formatUrl('https://staging.example.com/a@b')).toBe('https://staging.example.com/a@b')
    // A password containing '@'
    expect(formatUrl('https://user:p@ss@host.example/x', { stripQuery: false })).toBe('https://host.example/x')
  })

  it('strips the query, also inside a hash route, and keeps the protocol', () => {
    expect(formatUrl('https://app.example.com/a?token=1#/ws/42?tab=2')).toBe('https://app.example.com/a#/ws/42')
  })

  it('drops a fragment that is not a route, such as an OAuth token', () => {
    expect(formatUrl('https://app.example.com/callback#access_token=eyJ.x&state=1')).toBe('https://app.example.com/callback')
    expect(formatUrl('https://app.example.com/docs#install')).toBe('https://app.example.com/docs')
    expect(formatUrl('https://app.example.com/#!/ws/1?x=2')).toBe('https://app.example.com/#!/ws/1')
  })

  it('keeps the query with stripQuery: false', () => {
    expect(formatUrl('https://x.com/?a=1', { stripQuery: false })).toBe('https://x.com/?a=1')
  })

  it('masks every literal and regex match', () => {
    expect(formatUrl('https://acme-1.example.com/acme-1/x', { redact: ['acme-1'] })).toBe('https://***.example.com/***/x')
    expect(formatUrl('https://a.com/u/123/v/456', { redact: [/\d+/g], redactWith: '#' })).toBe('https://a.com/u/#/v/#')
  })
})

describe('urlAt', () => {
  const urls = [url('p', 'about:blank', 0), url('p', 'https://a.com/', 10), url('p', 'https://a.com/#/x', 50)]
  it('is the latest URL at or before t, skipping about: pages', () => {
    expect(urlAt(urls, 'p', 5)).toBe('https://a.com/')
    expect(urlAt(urls, 'p', 50)).toBe('https://a.com/#/x')
    expect(urlAt(urls, 'q', 50)).toBeUndefined()
  })
})

describe('buildUrlBarCues', () => {
  const pageUrls = [
    url('main', 'https://console.example.com/', 100),
    url('main', 'https://console.example.com/#/db', 400),
    url('popup', 'https://auth.example.org/authorize?state=x', 1210),
    url('main', 'https://app.snowflake.example/home', 2500),
  ]
  const activePage = (t: number) => (t >= 1200 && t < 1900 ? 'popup' : 'main')
  const base = { pageUrls, activePage, pageSwitches: [1200, 1900], markers: [], hiddenRanges: [], startMs: 0, endMs: 3000 }

  it('host-change: the first host is the baseline; each new host shows once', () => {
    const cues = buildUrlBarCues({ ...base, config: {} })
    expect(cues).toEqual([
      { text: 'https://auth.example.org/authorize', startMs: 1200 },
      { text: 'https://console.example.com/#/db', startMs: 1900 },
      { text: 'https://app.snowflake.example/home', startMs: 2500 },
    ])
  })

  it('host-change: a host seen only inside hidden steps does not count', () => {
    const cues = buildUrlBarCues({ ...base, config: {}, hiddenRanges: [{ start: 1100, end: 2000 }] })
    expect(cues.map((c) => [c.text, c.startMs])).toEqual([['https://app.snowflake.example/home', 2500]])
  })

  it('host-change: a hidden setup on another host sets the baseline at the first visible frame', () => {
    const cues = buildUrlBarCues({ ...base, config: {}, hiddenRanges: [{ start: 0, end: 2600 }] })
    expect(cues).toEqual([])
  })

  it('always: follows every visible URL change until the next', () => {
    const cues = buildUrlBarCues({ ...base, config: { show: 'always' } })
    expect(cues.map((c) => [c.text, c.startMs, c.endMs])).toEqual([
      ['https://console.example.com/', 0, 400],
      ['https://console.example.com/#/db', 400, 1200],
      ['https://auth.example.org/authorize', 1200, 1900],
      ['https://console.example.com/#/db', 1900, 2500],
      ['https://app.snowflake.example/home', 2500, undefined],
    ])
  })

  it('marked: shows the marker URL, else the URL on screen', () => {
    const cues = buildUrlBarCues({
      ...base,
      config: { show: 'marked', redact: ['snowflake'] },
      markers: [{ startMs: 500 }, { startMs: 2600, url: 'https://app.snowflake.example/x?y=1' }],
    })
    expect(cues).toEqual([
      { text: 'https://console.example.com/#/db', startMs: 500 },
      { text: 'https://app.***.example/x', startMs: 2600 },
    ])
  })
})
