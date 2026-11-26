import { describe, expect, it } from 'vitest'
import { canStep, emptyHistory, prune, recordVisit, step, type NavHistory } from '../navHistory'

const same = (a: string, b: string): boolean => a === b
const always = (): boolean => true

function visit(...entries: string[]): NavHistory<string> {
  return entries.reduce((history, entry) => recordVisit(history, entry, same), emptyHistory<string>())
}

describe('navHistory', () => {
  it('records visits in order and ignores a repeat of the current one', () => {
    const history = visit('a', 'b')
    expect(history).toEqual({ entries: ['a', 'b'], index: 1 })
    expect(recordVisit(history, 'b', same)).toBe(history)
  })

  it('replaces the current entry when the new one supersedes it', () => {
    const supersedes = (current: string, next: string): boolean => current === 'beta' && next.startsWith('beta/')
    const history = recordVisit(visit('alpha', 'beta'), 'beta/shell', same, { supersedes })
    expect(history).toEqual({ entries: ['alpha', 'beta/shell'], index: 1 })
    expect(recordVisit(history, 'docs', same, { supersedes })).toEqual({ entries: ['alpha', 'beta/shell', 'docs'], index: 2 })
  })

  it('drops forward entries when a new place is visited after going back', () => {
    const back = step(visit('a', 'b', 'c'), 'back', always)
    expect(back?.entry).toBe('b')
    expect(recordVisit(back?.history ?? emptyHistory<string>(), 'd', same)).toEqual({ entries: ['a', 'b', 'd'], index: 2 })
  })

  it('keeps at most max entries, dropping the oldest', () => {
    let history = emptyHistory<string>()
    for (let i = 0; i < 60; i++) history = recordVisit(history, String(i), same, { max: 50 })
    expect(history.entries).toHaveLength(50)
    expect(history.entries[0]).toBe('10')
    expect(history.index).toBe(49)
  })

  it('steps back and forward, skipping places that are gone', () => {
    const usable = (entry: string): boolean => entry !== 'c'
    const back = step(visit('a', 'b', 'c', 'd'), 'back', usable)
    expect(back?.entry).toBe('b')
    expect(back?.history.index).toBe(1)
    const forward = step(back?.history ?? emptyHistory<string>(), 'forward', usable)
    expect(forward?.entry).toBe('d')
    expect(forward?.history.index).toBe(3)
  })

  it('returns null with nowhere to go, and canStep agrees', () => {
    expect(step(emptyHistory<string>(), 'back', always)).toBeNull()
    const one = visit('a')
    expect(step(one, 'back', always)).toBeNull()
    expect(canStep(one, 'back', always)).toBe(false)
    expect(canStep(one, 'forward', always)).toBe(false)
    expect(canStep(visit('a', 'b'), 'back', always)).toBe(true)
    expect(canStep(visit('a', 'b'), 'back', (entry) => entry !== 'a')).toBe(false)
  })

  it('passes over places that would show what is already showing', () => {
    /** `b` again behind a place that's gone; a tabless `ctx` that shows `ctx/b` now. */
    const usable = (entry: string): boolean => entry !== 'gone'
    const shows = (entry: string): string => (entry === 'ctx' ? 'ctx/b' : entry)
    const back = step(visit('a', 'b', 'gone', 'b'), 'back', usable, undefined, same)
    expect(back?.entry).toBe('a')
    expect(back?.history.index).toBe(0)
    expect(step(visit('ctx', 'ctx/b'), 'back', always, shows, same)).toBeNull()
    expect(canStep(visit('ctx', 'ctx/b'), 'back', always, shows, same)).toBe(false)
    expect(canStep(visit('a', 'b', 'gone', 'b'), 'back', usable, undefined, same)).toBe(true)
  })

  it('recording the entry step landed on changes nothing, so Forward survives', () => {
    const back = step(visit('a', 'b', 'c'), 'back', always)
    const history = back?.history ?? emptyHistory<string>()
    expect(recordVisit(history, 'b', same)).toBe(history)
    expect(canStep(history, 'forward', always)).toBe(true)
  })

  it('prunes removed places and keeps the index on the current one', () => {
    const keep = (entry: string): boolean => entry !== 'w'
    expect(prune(visit('a', 'w', 'b', 'w', 'c'), keep, same)).toEqual({ entries: ['a', 'b', 'c'], index: 2 })
    expect(prune(visit('a', 'b'), (entry) => entry !== 'b', same)).toEqual({ entries: ['a'], index: 0 })
  })

  it('collapses neighbours that become the same after pruning, and moves the index to an earlier survivor', () => {
    const atW = step(visit('a', 'w', 'a', 'b'), 'back', always)
    expect(atW?.entry).toBe('a')
    const back = step(atW?.history ?? emptyHistory<string>(), 'back', always)
    expect(back?.entry).toBe('w')
    expect(prune(back?.history ?? emptyHistory<string>(), (entry) => entry !== 'w', same)).toEqual({ entries: ['a', 'b'], index: 0 })
    expect(prune(visit('w'), (entry) => entry !== 'w', same)).toEqual({ entries: [], index: -1 })
  })
})

describe('navHistory with tabless places', () => {
  type Place = { ctx: string; tab: string | null }
  const samePlace = (a: Place, b: Place): boolean => a.ctx === b.ctx && a.tab === b.tab
  const supersedes = (current: Place, next: Place): boolean => current.tab === null && current.ctx === next.ctx
  const record = (history: NavHistory<Place>, place: Place): NavHistory<Place> => recordVisit(history, place, samePlace, { supersedes })

  it('lands on what will actually show, so recording it keeps Back and Forward', () => {
    let history = emptyHistory<Place>()
    for (const place of [
      { ctx: 'W', tab: null },
      { ctx: 'D', tab: null },
      { ctx: 'W', tab: null },
      { ctx: 'W', tab: 'f' }
    ])
      history = record(history, place)
    expect(history.entries).toEqual([
      { ctx: 'W', tab: null },
      { ctx: 'D', tab: null },
      { ctx: 'W', tab: 'f' }
    ])
    /** Applying a tabless place shows the context's active tab, here `f`. */
    const shows = (place: Place): Place => (place.tab === null && place.ctx === 'W' ? { ...place, tab: 'f' } : place)
    const toD = step(history, 'back', always, shows)
    const toW = step(toD?.history ?? emptyHistory<Place>(), 'back', always, shows)
    expect(toW?.entry).toEqual({ ctx: 'W', tab: 'f' })
    const after = record(toW?.history ?? emptyHistory<Place>(), { ctx: 'W', tab: 'f' })
    expect(after).toBe(toW?.history)
    expect(canStep(after, 'forward', always)).toBe(true)
    expect(after.entries).toHaveLength(3)
  })
})
