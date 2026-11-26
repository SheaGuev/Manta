import { describe, expect, it } from 'vitest'
import { briefRequest, docsEdit, launchRequest, mapFeedback, threadIds, mapSettings, newMapInput, picks, trackerEdit } from '../mapArgs'

describe('map IPC arguments', () => {
  it('accepts well-formed edits and fills defaults', () => {
    expect(newMapInput({ title: 'Auth' })).toEqual({ title: 'Auth', description: '', projects: [], launchMode: 'ticket' })
    expect(trackerEdit({ kind: 'set-ticket-status', ticket: 'tk_1', status: 'blocked', reason: 'Key' })).toEqual({ kind: 'set-ticket-status', ticket: 'tk_1', status: 'blocked', reason: 'Key' })
    expect(trackerEdit({ kind: 'update-ticket', ticket: 'tk_1', docs: [{ path: 'a.md' }], project: null })).toEqual({ kind: 'update-ticket', ticket: 'tk_1', docs: [{ path: 'a.md', heading: null }], project: null })
    expect(docsEdit({ kind: 'add-doc', path: 'a.md' })).toEqual({ kind: 'add-doc', path: 'a.md', milestones: [], section: null })
    expect(mapSettings({ pinned: null, sweep: false })).toEqual({ pinned: null, sweep: false })
    expect(picks(null)).toBeNull()
  })

  it('accepts decisions, definitions of done, constraints, doc roles and the new settings', () => {
    expect(trackerEdit({ kind: 'add-decision', title: 'Domain', blocks: ['tk_1'] })).toEqual({ kind: 'add-decision', title: 'Domain', blocks: ['tk_1'] })
    expect(
      trackerEdit({ kind: 'update-decision', decision: 'dc_1', status: 'decided', outcome: 'x', docs: [{ path: 'd.md' }], options: [{ title: 'A', recommended: true }], chosen: 0, input: { label: 'Domain', value: 'omni.app' } })
    ).toEqual({
      kind: 'update-decision',
      decision: 'dc_1',
      status: 'decided',
      outcome: 'x',
      docs: [{ path: 'd.md', heading: null }],
      options: [{ title: 'A', detail: '', recommended: true }],
      chosen: 0,
      input: { label: 'Domain', value: 'omni.app' }
    })
    expect(() => trackerEdit({ kind: 'update-decision', decision: 'dc_1', chosen: -1 })).toThrow('chosen must be an option index or null')
    expect(trackerEdit({ kind: 'update-decision', decision: 'dc_1', status: 'superseded' })).toEqual({ kind: 'update-decision', decision: 'dc_1', status: 'superseded' })
    expect(trackerEdit({ kind: 'remove-decision', decision: 'dc_1' })).toEqual({ kind: 'remove-decision', decision: 'dc_1' })
    expect(trackerEdit({ kind: 'update-milestone', milestone: 'ms_1', doneWhen: [{ text: 'a', done: true }, { text: 'b' }] })).toEqual({ kind: 'update-milestone', milestone: 'ms_1', doneWhen: [{ text: 'a', done: true }, { text: 'b', done: false }] })
    expect(() => trackerEdit({ kind: 'update-milestone', milestone: 'ms_1', doneWhen: ['a'] })).toThrow('doneWhen[0] must be an object')
    expect(() => trackerEdit({ kind: 'update-milestone', milestone: 'ms_1', doneWhen: [{ text: 'a', done: 'yes' }] })).toThrow('doneWhen[0].done must be true or false')
    expect(trackerEdit({ kind: 'update-ticket', ticket: 'tk_1', constraints: ['b'] })).toEqual({ kind: 'update-ticket', ticket: 'tk_1', constraints: ['b'] })
    expect(docsEdit({ kind: 'update-doc', path: 'a.md', roles: ['product'] })).toEqual({ kind: 'update-doc', path: 'a.md', roles: ['product'] })
    expect(docsEdit({ kind: 'add-link', url: 'https://x.dev', title: 'X' })).toEqual({ kind: 'add-link', url: 'https://x.dev', title: 'X', roles: [], milestones: [] })
    expect(docsEdit({ kind: 'update-doc', path: 'link:1', link: { url: 'https://x.dev', title: 'X' } })).toEqual({ kind: 'update-doc', path: 'link:1', link: { url: 'https://x.dev', title: 'X' } })
    expect(() => docsEdit({ kind: 'update-doc', path: 'link:1', link: { url: 3, title: 'X' } })).toThrow('link.url must be a string')
    expect(mapSettings({ key: 'OMN', stage: null })).toEqual({ key: 'OMN', stage: null })
    expect(() => trackerEdit({ kind: 'update-decision', decision: 'dc_1', status: 'maybe' })).toThrow('status must be one of open, decided')
    expect(() => docsEdit({ kind: 'update-doc', path: 'a.md', roles: ['marketing'] })).toThrow('roles[0] must be one of')
    expect(() => mapSettings({ stage: 'done' })).toThrow('stage must be one of')
  })

  it('takes a start note and the brief page’s request', () => {
    expect(launchRequest({ docsRoot: '/d', map: 'm_1', scope: { ticket: 'tk_1' }, mode: 'ticket', note: 'Keep it small', cols: 80, rows: 24 }).note).toBe('Keep it small')
    expect(briefRequest({ docsRoot: '/d', map: 'm_1', ticket: 'tk_1', mode: 'milestone' })).toEqual({ docsRoot: '/d', map: 'm_1', ticket: 'tk_1', mode: 'milestone', project: null, note: '' })
    expect(() => briefRequest({ docsRoot: '/d', map: 'm_1', ticket: 'tk_1', mode: 'ticket', note: 3 })).toThrow('note must be a string')
  })

  it('takes the doc updates to approve as thread ids', () => {
    expect(threadIds(['t_1'])).toEqual(['t_1'])
    expect(() => threadIds(['t_1', 2])).toThrow('include must be a list of thread ids')
  })

  it('throws on anything malformed, naming the field', () => {
    expect(() => trackerEdit({ kind: 'set-ticket-status', ticket: 'tk_1', status: 'finished' })).toThrow('status must be one of')
    expect(() => trackerEdit({ kind: 'delete-everything' })).toThrow('edit.kind is not a tracker edit')
    expect(() => docsEdit({ kind: 'add-doc', path: 3 })).toThrow('path must be a string')
    expect(() => mapSettings({ sweep: 'yes' })).toThrow('sweep must be a boolean')
    expect(mapSettings({ confirmProposals: 'queue' })).toEqual({ confirmProposals: 'queue' })
    expect(() => mapSettings({ confirmProposals: 'never' })).toThrow('confirmProposals')
    expect(() => launchRequest({ docsRoot: '/d', map: 'm_1', scope: { tickets: [] }, mode: 'ticket', cols: 80, rows: 24 })).toThrow('scope must name')
    expect(launchRequest({ docsRoot: '/d', map: 'm_1', scope: { ticket: 'tk_1' }, mode: 'ticket', batch: 'b_abc123', cols: 80, rows: 24 }).batch).toBe('b_abc123')
    expect(() => launchRequest({ docsRoot: '/d', map: 'm_1', scope: { ticket: 'tk_1' }, mode: 'ticket', batch: '../x', cols: 80, rows: 24 })).toThrow('batch must be a batch id')
    expect(() => launchRequest({ docsRoot: '/d', map: 'nope', scope: { ticket: 't' }, mode: 'ticket', cols: 80, rows: 24 })).toThrow('id must be a context map id')
    expect(() => picks([1, -1])).toThrow('pick must be')
  })

  it('checks the new fields: ticket criteria and dependencies, project checks, and the feedback kind', () => {
    expect(trackerEdit({ kind: 'update-ticket', ticket: 'tk_1', acceptance: ['a'], after: ['tk_2'] })).toEqual({ kind: 'update-ticket', ticket: 'tk_1', acceptance: ['a'], after: ['tk_2'] })
    expect(() => trackerEdit({ kind: 'update-ticket', ticket: 'tk_1', after: [1] })).toThrow('after must be a list of strings')
    expect(mapSettings({ checks: [{ project: 'app', commands: ['npm test'] }] })).toEqual({ checks: [{ project: 'app', commands: ['npm test'] }] })
    expect(() => mapSettings({ checks: [{ project: 'app' }] })).toThrow('checks[0].commands must be a list of strings')
    expect(mapFeedback('review')).toBe('review')
    expect(() => mapFeedback('praise')).toThrow('kind must be one of checks, review')
  })
})
