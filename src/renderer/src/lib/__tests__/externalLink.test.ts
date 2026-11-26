import { describe, expect, it } from 'vitest'
import { externalLink } from '../externalLink'

describe('externalLink', () => {
  it('opens web and mail links, naming where they go', () => {
    expect(externalLink('https://github.com/a/b/pull/8')).toEqual({ url: 'https://github.com/a/b/pull/8', where: 'github.com', openable: true })
    expect(externalLink('http://localhost:5173/x')).toMatchObject({ where: 'localhost:5173', openable: true })
    expect(externalLink('mailto:someone@example.com')).toMatchObject({ where: 'someone@example.com', openable: true })
  })

  it('refuses other protocols and text that is not a URL', () => {
    expect(externalLink('file:///etc/passwd')).toMatchObject({ openable: false })
    expect(externalLink('javascript:alert(1)')).toMatchObject({ openable: false })
    expect(externalLink('not a url')).toEqual({ url: 'not a url', where: 'not a url', openable: false })
  })
})
