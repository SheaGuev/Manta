import { describe, expect, it } from 'vitest'
import type { PullRequestCheck, PullRequestComment, PullRequestDetail, PullRequestStatus } from '../../../../shared/ipc'
import { checkSummary, chosenToSend, initiallyTicked, nextStatus, orderComments, readTicks, refreshInterval } from '../pullRequestView'

const item = (fields: Partial<PullRequestComment> & Pick<PullRequestComment, 'id' | 'kind'>): PullRequestComment => ({
  author: 'a',
  body: 'b',
  url: 'u',
  createdAt: '2026-10-20T10:00:00Z',
  path: null,
  line: null,
  side: null,
  hunk: null,
  resolved: false,
  outdated: false,
  replies: [],
  verdict: null,
  ...fields
})

const check = (state: PullRequestCheck['state']): PullRequestCheck => ({ name: state, state, url: null })

const found = (checks: PullRequestCheck[]): PullRequestStatus => {
  const pr: PullRequestDetail = {
    id: 'PR',
    number: 1,
    title: 't',
    state: 'open',
    url: 'u',
    baseRefName: 'main',
    baseRefOid: 'a',
    headRefName: 'b',
    headRefOid: 'c',
    author: 'x',
    viewer: 'y',
    checks,
    comments: [],
    truncated: false
  }
  return { kind: 'found', pr }
}

describe('orderComments', () => {
  it('orders unresolved threads by file and line, then conversation by time, with resolved ones apart', () => {
    const comments = [
      item({ id: 'c2', kind: 'comment', createdAt: '2026-10-22T00:00:00Z' }),
      item({ id: 'tB9', kind: 'thread', path: 'b.ts', line: 9 }),
      item({ id: 'tOut', kind: 'thread', path: 'a.ts', line: 1, outdated: true }),
      item({ id: 'r1', kind: 'review', createdAt: '2026-10-21T00:00:00Z' }),
      item({ id: 'tA20', kind: 'thread', path: 'a.ts', line: 20 }),
      item({ id: 'tA3', kind: 'thread', path: 'a.ts', line: 3 }),
      item({ id: 'done2', kind: 'thread', path: 'b.ts', line: 1, resolved: true }),
      item({ id: 'done1', kind: 'thread', path: 'a.ts', line: 5, resolved: true })
    ]
    const { open, resolved } = orderComments(comments)
    expect(open.map((c) => c.id)).toEqual(['tA3', 'tA20', 'tB9', 'tOut', 'r1', 'c2'])
    expect(resolved.map((c) => c.id)).toEqual(['done1', 'done2'])
  })
})

describe('initiallyTicked', () => {
  it('ticks unresolved current threads only', () => {
    const comments = [
      item({ id: 't', kind: 'thread', path: 'a', line: 1 }),
      item({ id: 'out', kind: 'thread', path: 'a', line: 1, outdated: true }),
      item({ id: 'done', kind: 'thread', path: 'a', line: 1, resolved: true }),
      item({ id: 'c', kind: 'comment' })
    ]
    expect([...initiallyTicked(comments)]).toEqual(['t'])
  })
})

describe('checkSummary', () => {
  it('summarises checks without zero counts', () => {
    expect(checkSummary([check('passed'), check('failed'), check('running'), check('running'), check('passed'), check('skipped')])).toBe(
      '1 failed · 2 running · 2 passed'
    )
    expect(checkSummary([check('passed')])).toBe('1 passed')
    expect(checkSummary([])).toBe('')
  })
})

describe('refreshInterval', () => {
  it('refreshes every 30 s only while a check is running', () => {
    expect(refreshInterval(found([check('running'), check('passed')]))).toBe(30_000)
    expect(refreshInterval(found([check('passed')]))).toBeNull()
    expect(refreshInterval({ kind: 'none', branch: 'b' })).toBeNull()
    expect(refreshInterval(null)).toBeNull()
  })
})

describe('nextStatus', () => {
  it('keeps the PR showing, with the error, when a refresh fails', () => {
    const shown = found([check('running')])
    const failed: PullRequestStatus = { kind: 'unavailable', reason: 'error connecting to api.github.com' }
    expect(nextStatus(shown, failed)).toEqual({ status: shown, error: 'error connecting to api.github.com' })
    expect(refreshInterval(nextStatus(shown, failed).status)).toBe(30_000)
    const none: PullRequestStatus = { kind: 'none', branch: 'b' }
    expect(nextStatus(shown, none)).toEqual({ status: none, error: null })
    expect(nextStatus(null, failed)).toEqual({ status: failed, error: null })
    expect(nextStatus(none, failed)).toEqual({ status: failed, error: null })
  })
})

describe('readTicks', () => {
  it('reads the ticks kept for a PR, and null when there are none or they are unreadable', () => {
    expect(readTicks('["a","b"]')).toEqual(new Set(['a', 'b']))
    expect(readTicks('[]')).toEqual(new Set())
    expect(readTicks(null)).toBeNull()
    expect(readTicks('{not json')).toBeNull()
    expect(readTicks('{"a":1}')).toBeNull()
    expect(readTicks('["a",3]')).toEqual(new Set(['a']))
  })
})

describe('chosenToSend', () => {
  it('sends only ticked comments the user can see: a resolved one only while its group is open', () => {
    const comments = [
      item({ id: 'open', kind: 'thread', path: 'a', line: 1 }),
      item({ id: 'done', kind: 'thread', path: 'a', line: 2, resolved: true }),
      item({ id: 'chat', kind: 'comment' }),
      item({ id: 'quiet', kind: 'comment' })
    ]
    const ticks = new Set(['open', 'done', 'chat', 'gone'])
    expect(chosenToSend(comments, ticks, false)).toEqual(['open', 'chat'])
    expect(chosenToSend(comments, ticks, true)).toEqual(['open', 'chat', 'done'])
  })
})
