import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { ThreadIndex, type ThreadEntry } from '../../../../core/threads/threads'
import { lineSegments, sectionMarkers, sectionTitle } from '../threadMarkers'

const DOC = '# Auth\n\nIntro.\n\n## Sessions\n\nSessions last 30 days.\n\n## Login\n\nMagic links.\n'
const FIELDS: Omit<ThreadEntry, 'anchor' | 'title'> = { status: 'open', parent: null, createdAt: '2026-10-16T00:00:00.000Z' }

describe('sectionTitle', () => {
  it('uses the heading of the section around the offset, or the paragraph start', () => {
    expect(sectionTitle(DOC, DOC.indexOf('30 days'))).toBe('Sessions')
    expect(sectionTitle('Just a paragraph here.\n', 3)).toBe('Just a paragraph here.')
    expect(sectionTitle(`${'word '.repeat(20)}\n`, 0)).toHaveLength(58)
  })
})

describe('sectionMarkers', () => {
  const at = (minute: number): string => `2026-10-16T00:${String(minute).padStart(2, '0')}:00.000Z`
  const markers = (index: ThreadIndex) =>
    sectionMarkers(index, 'auth.md', Text.of(index.text.toString().split('\n'))).map((s) => ({
      line: s.line,
      status: s.status,
      active: s.active.map((t) => t.id),
      closed: s.closed.map((t) => t.id)
    }))

  it('puts one marker on the first line of each section, for active threads only', () => {
    const ydoc = new Y.Doc()
    ydoc.getText('md').insert(0, DOC)
    const index = new ThreadIndex(ydoc)
    const sessions = { from: DOC.indexOf('## Sessions'), to: DOC.indexOf('30 days.') + '30 days.'.length }
    index.create('t_open', sessions, { ...FIELDS, title: 'Shorter', createdAt: at(3) })
    index.create('t_discarded', sessions, { ...FIELDS, title: 'Old idea', status: 'discarded', createdAt: at(2) })
    index.create('t_merged', sessions, { ...FIELDS, title: 'Landed', status: 'merged', createdAt: at(1) })
    index.create('t_closed_only', { from: 0, to: '# Auth'.length }, { ...FIELDS, title: 'Title', status: 'discarded', createdAt: at(4) })
    index.create('t_gone', { from: DOC.indexOf('## Login'), to: DOC.length - 1 }, { ...FIELDS, title: 'Login', createdAt: at(5) })
    index.create('t_sub', sessions, { ...FIELDS, title: 'Sub', parent: 't_open', createdAt: at(6) })
    index.text.delete(DOC.indexOf('## Login'), DOC.length - 1 - DOC.indexOf('## Login'))

    expect(markers(index)).toEqual([{ line: sessions.from, status: 'open', active: ['t_open'], closed: ['t_discarded', 't_merged'] }])
  })

  it('keeps a merged thread on its section while its changes are highlighted', () => {
    const ydoc = new Y.Doc()
    ydoc.getText('md').insert(0, DOC)
    const index = new ThreadIndex(ydoc)
    index.create('t_a', { from: 0, to: '# Auth'.length }, { ...FIELDS, title: 'Title', status: 'merged' })
    index.setLanded('t_a', [{ from: 2, to: 6, removed: 'Login' }])
    expect(markers(index)).toEqual([{ line: 0, status: 'merged', active: ['t_a'], closed: [] }])

    index.clearLanded('t_a')
    expect(markers(index)).toEqual([])
  })

  it('stays on the line the thread started on when that line is rewritten', () => {
    const ydoc = new Y.Doc()
    ydoc.getText('md').insert(0, '# draft title\n\nBody.\n')
    const index = new ThreadIndex(ydoc)
    index.create('t_a', { from: 0, to: '# draft title\n\nBody.'.length }, { ...FIELDS, title: 'Title' })
    index.text.delete(2, 'draft title'.length)
    index.text.insert(2, 'Final Title')
    index.text.insert(0, 'Intro\n\n')

    expect(markers(index).map((m) => m.line)).toEqual(['Intro\n\n'.length])
  })
})

describe('lineSegments', () => {
  it('splits a span at line breaks and drops empty lines', () => {
    const doc = Text.of(['# CCI UI RFC', '', '## Summary'])
    const slices = (from: number, to: number): string[] => lineSegments(doc, from, to).map((s) => doc.sliceString(s.from, s.to))
    expect(slices(2, 16)).toEqual(['CCI UI RFC', '##'])
    expect(slices(2, 5)).toEqual(['CCI'])
    expect(slices(12, 14)).toEqual([])
  })
})
