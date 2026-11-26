import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CachedRead } from '../cachedRead'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** A load that resolves when the test says so, counting how often it ran. */
function controlledLoad(): { load: () => Promise<number>; finish: () => void; count: () => number } {
  let runs = 0
  const pending: (() => void)[] = []
  return {
    load: () => {
      runs++
      const value = runs
      return new Promise<number>((resolve) => pending.push(() => resolve(value)))
    },
    finish: () => pending.shift()?.(),
    count: () => runs
  }
}

describe('CachedRead', () => {
  it('loads once, serves from memory until invalidated, then loads again', async () => {
    let runs = 0
    const cache = new CachedRead(async () => ++runs, { minGapMs: 0 })
    expect(await cache.read()).toBe(1)
    expect(await cache.read()).toBe(1)
    expect(cache.last).toBe(1)
    cache.invalidate()
    expect(await cache.read()).toBe(2)
  })

  it('shares one load between readers that arrive while it runs', async () => {
    const { load, finish, count } = controlledLoad()
    const cache = new CachedRead(load, { minGapMs: 0 })
    const first = cache.read()
    const second = cache.read()
    await vi.advanceTimersByTimeAsync(0)
    finish()
    expect(await Promise.all([first, second])).toEqual([1, 1])
    expect(count()).toBe(1)
  })

  it('answers a reader after a mid-load invalidation with a fresh load, not the one already reading', async () => {
    const { load, finish, count } = controlledLoad()
    const cache = new CachedRead(load, { minGapMs: 0 })
    const before = cache.read()
    await vi.advanceTimersByTimeAsync(0)
    cache.invalidate()
    const after = cache.read()
    const alsoAfter = cache.read()
    finish()
    expect(await before).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    finish()
    expect(await Promise.all([after, alsoAfter])).toEqual([2, 2])
    expect(count()).toBe(2)
  })

  it('waits out the gap after the previous load before loading a stale value again', async () => {
    let runs = 0
    const cache = new CachedRead(async () => ++runs, { minGapMs: 3000 })
    expect(await cache.read()).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    cache.invalidate()
    const next = cache.read()
    await vi.advanceTimersByTimeAsync(2800)
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(await next).toBe(2)
  })

  it('loads at once after a quiet gap', async () => {
    let runs = 0
    const cache = new CachedRead(async () => ++runs, { minGapMs: 3000 })
    await cache.read()
    await vi.advanceTimersByTimeAsync(5000)
    cache.invalidate()
    const next = cache.read()
    await vi.advanceTimersByTimeAsync(0)
    expect(await next).toBe(2)
  })

  it('skips the gap for an urgent invalidation, even for a load already waiting', async () => {
    let runs = 0
    const cache = new CachedRead(async () => ++runs, { minGapMs: 3000 })
    await cache.read()
    cache.invalidate()
    const waiting = cache.read()
    await vi.advanceTimersByTimeAsync(10)
    expect(runs).toBe(1)
    cache.invalidate(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(await waiting).toBe(2)
  })

  it('retries after a failed load', async () => {
    let fail = true
    const cache = new CachedRead(async () => {
      if (fail) throw new Error('git failed')
      return 'ok'
    }, { minGapMs: 0 })
    await expect(cache.read()).rejects.toThrow('git failed')
    fail = false
    expect(await cache.read()).toBe('ok')
  })
})
