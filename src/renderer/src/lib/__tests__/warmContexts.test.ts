import { describe, expect, it } from 'vitest'
import { touchWarm } from '../warmContexts'

describe('touchWarm', () => {
  it('puts a new context first', () => {
    expect(touchWarm({ warm: ['/a', '/b'], root: '/c', max: 4 })).toEqual(['/c', '/a', '/b'])
  })

  it('moves a context already warm to the front without repeating it', () => {
    expect(touchWarm({ warm: ['/a', '/b', '/c'], root: '/c', max: 4 })).toEqual(['/c', '/a', '/b'])
  })

  it('drops the least recent context past the cap', () => {
    expect(touchWarm({ warm: ['/d', '/c', '/b', '/a'], root: '/e', max: 4 })).toEqual(['/e', '/d', '/c', '/b'])
  })

  it('returns the same list when the context is already first, so state does not change', () => {
    const warm = ['/a', '/b']
    expect(touchWarm({ warm, root: '/a', max: 4 })).toBe(warm)
  })

  it('starts from an empty list', () => {
    expect(touchWarm({ warm: [], root: '/a', max: 4 })).toEqual(['/a'])
  })
})
