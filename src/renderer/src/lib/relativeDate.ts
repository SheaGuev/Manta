const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Past this, a date reads better than "40 days ago". */
const MAX_RELATIVE_DAYS = 30

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then the date itself. */
export function relativeDate(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  const ago = Math.max(0, now - then)
  if (ago < MINUTE) return 'just now'
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`
  const days = Math.floor(ago / DAY)
  if (days === 1) return 'yesterday'
  if (days <= MAX_RELATIVE_DAYS) return `${days} days ago`
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
