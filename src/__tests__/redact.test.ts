import { describe, expect, it } from 'vitest'
import { redactArgs, redactUrl } from '../redact'

describe('redactUrl', () => {
  it('redacts userinfo and query values and drops the fragment', () => {
    expect(
      redactUrl('http://user:pass@127.0.0.1:9222/path?token=abc&x=1#frag')
    ).toBe('http://***:***@127.0.0.1:9222/path?token=***&x=***')
  })

  it('normalizes a bare origin to a trailing slash without adding markers', () => {
    expect(redactUrl('http://127.0.0.1:9222')).toBe('http://127.0.0.1:9222/')
  })

  it('redacts a username without a password', () => {
    expect(redactUrl('https://user@example.com:9222/')).toBe(
      'https://***@example.com:9222/'
    )
  })

  it('keeps a query key without a value as a bare key', () => {
    expect(redactUrl('http://h:1/?flag&k=v')).toBe('http://h:1/?flag&k=***')
  })

  it('yields no query for an empty query', () => {
    expect(redactUrl('http://h:1/?')).toBe('http://h:1/')
  })

  it('does not echo an unparsable URL', () => {
    expect(redactUrl('not a url with secret')).toBe('[invalid URL]')
  })

  it.each([
    ['user:pass@127.0.0.1:9222', 'pass'],
    ['data:text/plain,secret', 'secret'],
    ['ftp://user:pass@host/', 'pass'],
  ])('does not echo a non-http(s) URL: %s', (input, secret) => {
    const out = redactUrl(input)
    expect(out).toBe('[invalid URL]')
    expect(out).not.toContain(secret)
  })

  it('never contains the original secrets', () => {
    const out = redactUrl('http://u:p4ss@h:1/x?t=s3cret#f1')
    for (const secret of ['u:p4ss', 'p4ss', 's3cret', 'f1']) {
      expect(out).not.toContain(secret)
    }
  })
})

describe('redactArgs', () => {
  it('redacts flag values and separate value tokens', () => {
    expect(
      redactArgs(['--api-key=s3cret', '--channel', 'stable', '--headless'])
    ).toEqual(['--api-key=***', '--channel', '***', '--headless'])
  })

  it('treats single-dash flags like double-dash flags', () => {
    expect(redactArgs(['-k=v', '-x'])).toEqual(['-k=***', '-x'])
  })
})
