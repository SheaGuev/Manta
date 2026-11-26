import { describe, expect, it } from 'vitest'
import { fileUri, relativeTo, uriPath } from '../fileUris'

describe('fileUri', () => {
  it('encodes each segment and keeps the slashes', () => {
    expect(fileUri('file:///work/app', 'src/my file#1.ts')).toBe('file:///work/app/src/my%20file%231.ts')
  })

  it('ignores a trailing slash on the root', () => {
    expect(fileUri('file:///work/app/', 'a.ts')).toBe('file:///work/app/a.ts')
  })
})

describe('uriPath', () => {
  it('decodes, so differently encoded URIs of one file compare equal', () => {
    expect(uriPath('file:///work/app/node_modules/%40types/x.d.ts')).toBe(uriPath('file:///work/app/node_modules/@types/x.d.ts'))
    expect(uriPath('file:///work/my%20app/a.ts')).toBe('/work/my app/a.ts')
  })

  it('returns text that is not a URI as it is', () => {
    expect(uriPath('not a uri')).toBe('not a uri')
  })
})

describe('relativeTo', () => {
  it('gives the path inside the root', () => {
    expect(relativeTo('file:///work/app', 'file:///work/app/src/a.ts')).toBe('src/a.ts')
  })

  it('is null outside the root, including a sibling that shares its prefix', () => {
    expect(relativeTo('file:///work/app', 'file:///work/app-2/a.ts')).toBeNull()
    expect(relativeTo('file:///work/app', 'file:///usr/lib/x.d.ts')).toBeNull()
  })
})
