import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const NOT_LISTED = new Set(['__tests__', 'README.md'])

function directories(dir: string): string[] {
  const subdirs = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !NOT_LISTED.has(entry.name))
  return [dir, ...subdirs.flatMap((entry) => directories(path.join(dir, entry.name)))]
}

function entries(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !NOT_LISTED.has(entry.name) && !entry.name.startsWith('.'))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort()
}

/** First-column names of the README's file table: rows shaped like "| `git.ts` | ... |". */
function tableEntries(readme: string): string[] {
  return [...readme.matchAll(/^\| `([^`]+)` \|/gm)].flatMap((match) => match[1] ?? []).sort()
}

describe.each(directories(SRC).map((dir) => path.join('src', path.relative(SRC, dir))))('%s', (relDir) => {
  const dir = path.join(SRC, '..', relDir)
  const readme = path.join(dir, 'README.md')

  it('has a README.md', () => {
    expect(existsSync(readme)).toBe(true)
  })

  it("lists exactly the folder's files and subfolders in its table", () => {
    if (!existsSync(readme)) return
    expect(tableEntries(readFileSync(readme, 'utf8'))).toEqual(entries(dir))
  })
})
