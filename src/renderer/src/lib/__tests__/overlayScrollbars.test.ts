import { describe, expect, it } from 'vitest'
import { thumbGeometry } from '../overlayScrollbars'

describe('thumbGeometry', () => {
  it('has no thumb when the content fits', () => {
    expect(thumbGeometry(500, 500, 0)).toBeNull()
    expect(thumbGeometry(500, 400, 0)).toBeNull()
  })

  it('sizes the thumb by the share of the content in view', () => {
    expect(thumbGeometry(500, 1000, 0)).toEqual({ size: 250, offset: 0 })
  })

  it('moves the thumb to the end of the track at the end of the scroll', () => {
    expect(thumbGeometry(500, 1000, 500)).toEqual({ size: 250, offset: 250 })
  })

  it('keeps the thumb big enough to grab', () => {
    expect(thumbGeometry(500, 100000, 0)?.size).toBe(28)
  })
})
