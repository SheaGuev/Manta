import { describe, expect, it } from 'vitest'
import { overviewMarks } from '../diffOverview'

describe('overviewMarks', () => {
  it('puts a chunk’s deleted lines above its added ones', () => {
    expect(overviewMarks([{ top: 100, deletedHeight: 40, insertedHeight: 60 }], 1000)).toEqual([
      { kind: 'deleted', top: 0.1, height: 0.04 },
      { kind: 'added', top: 0.14, height: 0.06 }
    ])
  })

  it('draws only the side a chunk has', () => {
    expect(overviewMarks([{ top: 0, deletedHeight: 0, insertedHeight: 20 }], 200)).toEqual([{ kind: 'added', top: 0, height: 0.1 }])
    expect(overviewMarks([{ top: 180, deletedHeight: 20, insertedHeight: 0 }], 200)).toEqual([{ kind: 'deleted', top: 0.9, height: 0.1 }])
  })

  it('keeps marks inside the strip when estimates overshoot', () => {
    expect(overviewMarks([{ top: 250, deletedHeight: 0, insertedHeight: 80 }], 200)).toEqual([{ kind: 'added', top: 1, height: 0.4 }])
  })

  it('draws nothing without chunks or height', () => {
    expect(overviewMarks([], 500)).toEqual([])
    expect(overviewMarks([{ top: 0, deletedHeight: 10, insertedHeight: 10 }], 0)).toEqual([])
  })
})
