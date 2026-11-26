import { describe, expect, it } from 'vitest'
import { legacyDocs, migrateLegacy, parseLegacyMap } from '../mapMigration'

const V1 = [
  '# Auth',
  '',
  'Sign-in.',
  '',
  '## Docs',
  '',
  '- [Sessions](docs/auth.md#Sessions) — how long they last',
  '- [Auth again](docs/auth.md) — duplicate',
  '- [Site](https://example.com) — external',
  '- [Spaced](docs/magic%20links.md)',
  '',
  '```md',
  '## Docs',
  '- [Not this](docs/fenced.md)',
  '```',
  '',
  '## Threads',
  '',
  '- [A thread](thread:t_1) — skipped'
].join('\n')

describe('migrating v1 maps', () => {
  it('reads only v1 metadata', () => {
    expect(parseLegacyMap({ id: 'm_1', title: 'Auth', about: 'Sign-in', createdAt: 'x', basis: {} })).toEqual({ id: 'm_1', title: 'Auth', about: 'Sign-in', createdAt: 'x' })
    expect(parseLegacyMap({ version: 2, id: 'm_1', title: 'Auth', createdAt: 'x' })).toBeNull()
  })

  it('keeps the docs list once each, without sections, external links or fenced examples', () => {
    expect(legacyDocs(V1)).toEqual(['docs/auth.md', 'docs/magic links.md'])
  })

  it('turns title and about into title and description, with the docs on no milestone', () => {
    expect(migrateLegacy({ id: 'm_1', title: 'Auth', about: 'Sign-in', createdAt: 'x' }, V1)).toMatchObject({
      version: 2,
      title: 'Auth',
      description: 'Sign-in',
      docs: [
        { path: 'docs/auth.md', milestones: [], section: null },
        { path: 'docs/magic links.md', milestones: [], section: null }
      ]
    })
  })
})
