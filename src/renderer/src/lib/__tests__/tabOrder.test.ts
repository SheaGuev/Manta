import { describe, expect, it } from 'vitest'
import { reorder } from '../tabOrder'

const key = (tab: string): string => tab

describe('reorder', () => {
  it('moves a tab before or after another', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 'a', 'c', 'after', key)).toEqual(['b', 'c', 'a', 'd'])
    expect(reorder(['a', 'b', 'c', 'd'], 'a', 'c', 'before', key)).toEqual(['b', 'a', 'c', 'd'])
    expect(reorder(['a', 'b', 'c', 'd'], 'd', 'a', 'before', key)).toEqual(['d', 'a', 'b', 'c'])
    expect(reorder(['a', 'b', 'c', 'd'], 'd', 'b', 'after', key)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('returns the same list when nothing moves or a key is unknown', () => {
    const tabs = ['a', 'b', 'c']
    expect(reorder(tabs, 'b', 'b', 'after', key)).toBe(tabs)
    expect(reorder(tabs, 'a', 'b', 'before', key)).toBe(tabs)
    expect(reorder(tabs, 'x', 'b', 'after', key)).toBe(tabs)
    expect(reorder(tabs, 'a', 'x', 'after', key)).toBe(tabs)
  })
})
