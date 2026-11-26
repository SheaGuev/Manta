import { describe, expect, it } from 'vitest'
import { isWatchIgnored } from '../watchIgnore'

describe('isWatchIgnored', () => {
  it('ignores changes inside git, dependency and build folders at any depth', () => {
    expect(isWatchIgnored('.git/index')).toBe(true)
    expect(isWatchIgnored('node_modules/react/index.js')).toBe(true)
    expect(isWatchIgnored('packages/app/node_modules/x/y.js')).toBe(true)
    expect(isWatchIgnored('dist')).toBe(true)
    expect(isWatchIgnored('services/api/.venv/bin/python')).toBe(true)
  })

  it('keeps docs, sources and Manta records, including names that only contain an ignored word', () => {
    expect(isWatchIgnored('docs/auth.md')).toBe(false)
    expect(isWatchIgnored('src/build-tools.ts')).toBe(false)
    expect(isWatchIgnored('notes/distribution.md')).toBe(false)
    expect(isWatchIgnored('.manta/threads/t_1.json')).toBe(false)
  })
})
