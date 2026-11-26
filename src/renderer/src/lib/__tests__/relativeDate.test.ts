import { describe, expect, it } from 'vitest'
import { relativeDate } from '../relativeDate'

const NOW = Date.parse('2026-10-21T12:00:00Z')
const before = (ms: number): string => new Date(NOW - ms).toISOString()

describe('relativeDate', () => {
  it.each([
    [10_000, 'just now'],
    [5 * 60_000, '5 min ago'],
    [3 * 3_600_000, '3 h ago'],
    [30 * 3_600_000, 'yesterday'],
    [4 * 86_400_000, '4 days ago'],
    [30 * 86_400_000, '30 days ago']
  ])('%i ms ago reads %s', (ms, text) => {
    expect(relativeDate(before(ms), NOW)).toBe(text)
  })

  it('shows the date past a month, and a future date as just now', () => {
    expect(relativeDate('2026-08-01T12:00:00Z', NOW)).toMatch(/2026/)
    expect(relativeDate(new Date(NOW + 60_000).toISOString(), NOW)).toBe('just now')
  })

  it('returns text it cannot parse unchanged', () => {
    expect(relativeDate('not a date', NOW)).toBe('not a date')
  })
})
