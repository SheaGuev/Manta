import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { findQuote, parseEntry, parseRecord, sectionAt, ThreadIndex, type ThreadEntry, type ThreadRecord } from '../threads'

const DOC = '# Auth\n\nIntro.\n\n## Sessions\n\nSessions last 30 days.\n\n### Refresh\n\nRefresh daily.\n\n## Login\n\nMagic links.\n'

function indexFor(markdown: string): ThreadIndex {
  const ydoc = new Y.Doc()
  ydoc.getText('md').insert(0, markdown)
  return new ThreadIndex(ydoc)
}

function slice(index: ThreadIndex, id: string): string | null {
  const range = index.resolve(id)
  return range ? index.text.toString().slice(range.from, range.to) : null
}

const FIELDS: Omit<ThreadEntry, 'anchor'> = { title: 'Session length', status: 'open', parent: null, createdAt: '2026-10-16T00:00:00.000Z' }

describe('sectionAt', () => {
  it('covers a heading section up to the next heading of the same level, nested headings included', () => {
    const range = sectionAt(DOC, DOC.indexOf('last 30'))
    expect(DOC.slice(range.from, range.to)).toBe('## Sessions\n\nSessions last 30 days.\n\n### Refresh\n\nRefresh daily.')
  })

  it('runs to the end of the doc for the last section', () => {
    const range = sectionAt(DOC, DOC.indexOf('Magic'))
    expect(DOC.slice(range.from, range.to)).toBe('## Login\n\nMagic links.')
  })

  it('falls back to the paragraph when no heading encloses the offset', () => {
    const text = 'First line\nsame paragraph.\n\nSecond paragraph.\n'
    const range = sectionAt(text, text.indexOf('same'))
    expect(text.slice(range.from, range.to)).toBe('First line\nsame paragraph.')
  })

  it('ignores # lines inside fenced code', () => {
    const text = '## Setup\n\n```sh\n# not a heading\n```\n\nDone.\n'
    const range = sectionAt(text, text.indexOf('Done'))
    expect(text.slice(range.from, range.to)).toBe('## Setup\n\n```sh\n# not a heading\n```\n\nDone.')
  })
})

describe('ThreadIndex', () => {
  it('keeps the anchor on its section through edits inside, before and after it', () => {
    const index = indexFor(DOC)
    index.create('t_1', sectionAt(DOC, DOC.indexOf('## Login')), FIELDS)

    index.text.insert(0, '> Draft\n\n')
    index.text.insert(index.text.toString().indexOf('Magic'), 'Passwordless ')
    index.text.insert(index.text.length, '\n## Appendix\n')
    index.text.delete(index.text.toString().indexOf('Intro.'), 'Intro.'.length)

    expect(slice(index, 't_1')).toBe('## Login\n\nPasswordless Magic links.')
  })

  it('reports a thread as detached when its section is deleted, and keeps the entry', () => {
    const index = indexFor(DOC)
    const range = sectionAt(DOC, DOC.indexOf('## Login'))
    index.create('t_1', range, FIELDS)

    index.text.delete(range.from, range.to - range.from)

    expect(index.resolve('t_1')).toBeNull()
    expect(index.list('auth.md')).toEqual([expect.objectContaining({ id: 't_1', range: null })])
  })

  it('refuses empty or out-of-range anchors', () => {
    const index = indexFor(DOC)
    expect(() => index.create('t_1', { from: 3, to: 3 }, FIELDS)).toThrow('not inside the doc')
    expect(() => index.create('t_1', { from: 0, to: DOC.length + 1 }, FIELDS)).toThrow('not inside the doc')
  })

  it('re-anchors a record from another CRDT history by its quote', () => {
    const original = indexFor(DOC)
    original.create('t_1', sectionAt(DOC, DOC.indexOf('## Sessions')), FIELDS)
    const record = original.toRecord('t_1', 'auth.md', null)

    const fresh = indexFor(DOC)
    expect(fresh.adopt(record)).toBe(true)
    fresh.text.insert(fresh.text.toString().indexOf('30'), 'about ')

    expect(slice(fresh, 't_1')).toBe('## Sessions\n\nSessions last about 30 days.\n\n### Refresh\n\nRefresh daily.')
    expect(fresh.adopt(record)).toBe(false)
  })

  it('keeps a detached thread detached instead of re-finding stale text', () => {
    const index = indexFor(DOC)
    const range = sectionAt(DOC, DOC.indexOf('## Login'))
    index.create('t_1', range, FIELDS)
    const record = index.toRecord('t_1', 'auth.md', null)
    index.text.delete(range.from, range.to - range.from)
    index.text.insert(index.text.length, '## Login\n\nMagic links.')

    expect(index.adopt(record)).toBe(false)
    expect(index.resolve('t_1')).toBeNull()
    expect(index.toRecord('t_1', 'auth.md', record).anchor.quote).toEqual(record.anchor.quote)
  })

  it('stores a record it cannot place as detached rather than dropping it', () => {
    const record = indexFor(DOC)
    record.create('t_1', sectionAt(DOC, DOC.indexOf('## Login')), FIELDS)
    const fresh = indexFor('# Something else\n')

    expect(fresh.adopt(record.toRecord('t_1', 'auth.md', null))).toBe(true)
    expect(fresh.list('auth.md')).toEqual([expect.objectContaining({ id: 't_1', title: 'Session length', range: null })])
  })
})

describe('ThreadIndex landed changes', () => {
  it('keeps what a thread changed attached to its text through later edits, until cleared', () => {
    const index = indexFor(DOC)
    index.create('t_1', sectionAt(DOC, DOC.indexOf('## Login')), FIELDS)
    const from = DOC.indexOf('Magic')
    index.setLanded('t_1', [{ from, to: from + 'Magic'.length, removed: 'Password' }])

    index.text.insert(0, '> Draft\n\n')
    const [change] = index.landed('t_1')
    expect(change && index.text.toString().slice(change.from, change.to)).toBe('Magic')
    expect(change?.removed).toBe('Password')
    expect(parseEntry(JSON.parse(JSON.stringify(index.map.get('t_1'))))?.landed).toHaveLength(1)

    index.setStatus('t_1', 'merged')
    expect(index.landed('t_1')).toHaveLength(1)
    index.clearLanded('t_1')
    expect(index.landed('t_1')).toEqual([])
    expect(index.get('t_1')).toMatchObject({ status: 'merged', title: 'Session length' })
  })
})

describe('findQuote', () => {
  it('picks the occurrence whose surrounding text matches the recorded context', () => {
    const text = '## A\n\n### Open questions\n\nNone.\n\n## B\n\n### Open questions\n\nNone.\n'
    const second = text.lastIndexOf('### Open questions')
    const found = findQuote(text, { exact: '### Open questions\n\nNone.', prefix: '## B\n\n', suffix: '\n' })
    expect(found).toEqual({ from: second, to: second + '### Open questions\n\nNone.'.length })
  })

  it('returns null when the text is gone', () => {
    expect(findQuote('# Nothing\n', { exact: 'Sessions', prefix: '', suffix: '' })).toBeNull()
  })
})

describe('parseRecord', () => {
  it('round-trips a record through JSON and rejects malformed ones', () => {
    const index = indexFor(DOC)
    index.create('t_1', sectionAt(DOC, DOC.indexOf('## Login')), FIELDS)
    const record: ThreadRecord = index.toRecord('t_1', 'auth.md', null)

    expect(parseRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
    expect(parseRecord({ ...record, status: 'deleted' })).toBeNull()
    expect(parseRecord({ ...record, version: 2 })).toBeNull()
    expect(parseRecord({ ...record, anchor: { crdt: null } })).toBeNull()
  })
})

describe('implementation threads in the index', () => {
  const LINK = { source: null, project: '/code/app', worktree: '/code/app.worktrees/login', branch: 'manta/login', session: 's-1', terminal: 'term_1', hidden: false, base: null, pr: null }

  it('lists the link, and shows a landed implementation until it is hidden', () => {
    const index = indexFor(DOC)
    index.create('t_1', sectionAt(DOC, DOC.indexOf('## Login')), { ...FIELDS, implementation: LINK })
    index.create('t_2', sectionAt(DOC, DOC.indexOf('## Sessions')), FIELDS)

    expect(index.list('auth.md').find((t) => t.id === 't_1')).toMatchObject({ implementation: LINK, highlighted: false })
    expect(index.list('auth.md').find((t) => t.id === 't_2')?.implementation).toBeNull()

    index.setStatus('t_1', 'merged')
    expect(index.list('auth.md').find((t) => t.id === 't_1')?.highlighted).toBe(true)
    index.setImplementation('t_1', { ...LINK, hidden: true })
    expect(index.list('auth.md').find((t) => t.id === 't_1')?.highlighted).toBe(false)
    expect(() => index.setImplementation('t_2', LINK)).toThrow(/not an implementation/)
  })

  it('round-trips the link through entries and records, and still reads records from before it existed', () => {
    const index = indexFor(DOC)
    index.create('t_1', sectionAt(DOC, DOC.indexOf('## Login')), { ...FIELDS, implementation: LINK })
    const record = index.toRecord('t_1', 'auth.md', null)

    expect(parseEntry(JSON.parse(JSON.stringify(index.map.get('t_1'))))?.implementation).toEqual(LINK)
    expect(parseRecord(JSON.parse(JSON.stringify(record)))).toEqual(record)
    expect(parseRecord({ ...record, implementation: { ...LINK, branch: 3 } })).toBeNull()
    const { implementation: _, ...older } = record
    expect(parseRecord(older)).toEqual(older)
    expect(parseRecord(older)).not.toHaveProperty('implementation')
  })

  it('brings the link along when a fresh clone adopts the record', () => {
    const index = indexFor(DOC)
    index.create('t_1', sectionAt(DOC, DOC.indexOf('## Login')), { ...FIELDS, implementation: LINK })
    const record = index.toRecord('t_1', 'auth.md', null)

    const fresh = indexFor(DOC)
    expect(fresh.adopt(record)).toBe(true)
    expect(fresh.get('t_1')?.implementation).toEqual(LINK)
  })
})
