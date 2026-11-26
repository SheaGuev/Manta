import type { ContentMatch } from '../../../shared/ipc'

/** Paths containing `query` (case-insensitive), those whose file name matches ahead of folder-only matches. */
export function matchFileNames(files: readonly string[], query: string, limit: number): string[] {
  const needle = query.toLowerCase()
  const named: string[] = []
  const inFolder: string[] = []
  for (const file of files) {
    const lower = file.toLowerCase()
    if (!lower.includes(needle)) continue
    if ((lower.split('/').pop() ?? lower).includes(needle)) named.push(file)
    else inFolder.push(file)
  }
  return [...named, ...inFolder].slice(0, limit)
}

export interface FileMatches {
  path: string
  matches: ContentMatch[]
}

/** Groups matches by file, keeping the order files first appear in. */
export function groupByFile(matches: readonly ContentMatch[]): FileMatches[] {
  const groups = new Map<string, ContentMatch[]>()
  for (const match of matches) groups.set(match.path, [...(groups.get(match.path) ?? []), match])
  return [...groups].map(([path, grouped]) => ({ path, matches: grouped }))
}

/** Splits `text` around each case-insensitive occurrence of `query`, for highlighting. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  if (!query) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  const parts: { text: string; match: boolean }[] = []
  let at = 0
  for (let found = lower.indexOf(needle); found !== -1; found = lower.indexOf(needle, at)) {
    if (found > at) parts.push({ text: text.slice(at, found), match: false })
    parts.push({ text: text.slice(found, found + needle.length), match: true })
    at = found + needle.length
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false })
  return parts
}

export interface FuzzyMatch {
  path: string
  score: number
  /** Indexes into `path` of the matched characters, for highlighting. */
  positions: number[]
}

/** A run outweighs a word start, so `git` takes the `t` in `git.ts`, not the one starting `ts`. */
const MATCH = 1
const WORD_START = 6
const RUN = 8
const IN_FILE_NAME = 3

function isWordStart(path: string, index: number): boolean {
  if (index === 0) return true
  const before = path.charAt(index - 1)
  if ('/.-_ '.includes(before)) return true
  const here = path.charAt(index)
  return before === before.toLowerCase() && here !== here.toLowerCase()
}

/**
 * Every character of `query` in `path`, in order and case-insensitive, or null when one is missing.
 * Picks the placement that scores best: characters at word starts (after `/ . - _`, or a camelCase
 * hump), in runs, and in the file name rather than its folders. So `chpan` finds `ChangesPanel.tsx`.
 */
export function fuzzyMatch(path: string, query: string): FuzzyMatch | null {
  const lower = path.toLowerCase()
  const needle = query.toLowerCase()
  if (!needle) return { path, score: 0, positions: [] }
  let at = 0
  for (const char of needle) {
    at = lower.indexOf(char, at) + 1
    if (at === 0) return null
  }
  const nameStart = path.lastIndexOf('/') + 1
  const charScore = (index: number): number => MATCH + (isWordStart(path, index) ? WORD_START : 0) + (index >= nameStart ? IN_FILE_NAME : 0)
  /** best[i][j]: the best score with query character i at path index j; from[i][j] the index of character i - 1. */
  const best: number[][] = []
  const from: number[][] = []
  for (let i = 0; i < needle.length; i++) {
    const row = new Array<number>(path.length).fill(Number.NEGATIVE_INFINITY)
    const back = new Array<number>(path.length).fill(-1)
    const previous = best[i - 1]
    let bestBefore = Number.NEGATIVE_INFINITY
    let bestBeforeAt = -1
    for (let j = i; j < path.length; j++) {
      if (previous && j >= 2 && (previous[j - 2] ?? Number.NEGATIVE_INFINITY) > bestBefore) {
        bestBefore = previous[j - 2] ?? Number.NEGATIVE_INFINITY
        bestBeforeAt = j - 2
      }
      if (lower.charAt(j) !== needle.charAt(i)) continue
      if (!previous) {
        row[j] = charScore(j)
        continue
      }
      const adjacent = (previous[j - 1] ?? Number.NEGATIVE_INFINITY) + RUN
      if (adjacent >= bestBefore && adjacent > Number.NEGATIVE_INFINITY) {
        row[j] = adjacent + charScore(j)
        back[j] = j - 1
      } else if (bestBefore > Number.NEGATIVE_INFINITY) {
        row[j] = bestBefore + charScore(j)
        back[j] = bestBeforeAt
      }
    }
    best.push(row)
    from.push(back)
  }
  const last = best[needle.length - 1] ?? []
  let end = -1
  for (let j = 0; j < last.length; j++) if ((last[j] ?? Number.NEGATIVE_INFINITY) > (last[end] ?? Number.NEGATIVE_INFINITY)) end = j
  const positions: number[] = []
  for (let i = needle.length - 1, j = end; i >= 0 && j >= 0; i--) {
    positions.unshift(j)
    j = from[i]?.[j] ?? -1
  }
  return { path, score: last[end] ?? 0, positions }
}

/** Lowercased paths per file list, so each keystroke in quick open doesn't lowercase a big repo's paths again. */
const lowered = new WeakMap<readonly string[], string[]>()

function lowerPaths(files: readonly string[]): string[] {
  let list = lowered.get(files)
  if (!list) {
    list = files.map((file) => file.toLowerCase())
    lowered.set(files, list)
  }
  return list
}

/** Each character of `needle` in `lower`, in order: the cheap test before scoring. */
function isSubsequence(lower: string, needle: string): boolean {
  let at = 0
  for (const char of needle) {
    at = lower.indexOf(char, at) + 1
    if (at === 0) return false
  }
  return true
}

/**
 * The files matching `query`, best first; shorter paths win ties. Words separated by spaces must each
 * match (`auth panel`); their scores add up and every word's characters are highlighted.
 */
export function rankFiles(files: readonly string[], query: string, limit: number): FuzzyMatch[] {
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
  if (terms.length === 0) return []
  const lower = lowerPaths(files)
  const matches: FuzzyMatch[] = []
  files.forEach((file, index) => {
    const path = lower[index] ?? ''
    if (!terms.every((term) => isSubsequence(path, term))) return
    let score = 0
    const positions = new Set<number>()
    for (const term of terms) {
      const match = fuzzyMatch(file, term)
      if (!match) return
      score += match.score
      for (const position of match.positions) positions.add(position)
    }
    matches.push({ path: file, score, positions: [...positions].sort((a, b) => a - b) })
  })
  return matches.sort((a, b) => b.score - a.score || a.path.length - b.path.length).slice(0, limit)
}

/** Recent files that match come first, in the order they were opened, then everything else that matches. */
export function withRecentFirst({ ranked, recent }: { ranked: FuzzyMatch[]; recent: readonly string[] }): FuzzyMatch[] {
  const byPath = new Map(ranked.map((match) => [match.path, match]))
  const first = recent.flatMap((path) => byPath.get(path) ?? [])
  const firstPaths = new Set(first.map((match) => match.path))
  return [...first, ...ranked.filter((match) => !firstPaths.has(match.path))]
}

/** Splits quick open's text into the file query and an optional 1-based line: `auth.ts:42`. */
export function parseQuickOpen(text: string): { query: string; line: number | undefined } {
  const match = /^(.*?):(\d+)$/.exec(text.trim())
  if (!match?.[1]) return { query: text.trim(), line: undefined }
  return { query: match[1], line: Number(match[2]) }
}
