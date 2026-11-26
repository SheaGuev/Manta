import type { DocRole, MapDetail, MapDocInfo } from '../../../shared/ipc'

/** A doc split for the reader: the text before its first `## ` heading, then one part per `## ` heading. */
export interface DocParts {
  intro: string
  sections: { heading: string; body: string }[]
}

const FENCE = /^(```|~~~)/
const H1 = /^#[ \t]+\S/
const H2 = /^##[ \t]+(.+?)[ \t#]*$/

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/

/**
 * Splits a doc at its `## ` headings, outside code fences. Its YAML frontmatter and first `# `
 * title are dropped: the reader shows the doc's title and dates itself.
 */
export function splitDoc(text: string): DocParts {
  text = text.replace(FRONTMATTER, '')
  const intro: string[] = []
  const sections: { heading: string; lines: string[] }[] = []
  let inFence = false
  let titled = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence
    const h2 = inFence ? null : H2.exec(line)
    if (h2?.[1]) {
      sections.push({ heading: h2[1], lines: [] })
      continue
    }
    if (!inFence && !titled && sections.length === 0 && H1.test(line)) {
      titled = true
      continue
    }
    const last = sections.at(-1)
    if (last) last.lines.push(line)
    else intro.push(line)
  }
  return { intro: intro.join('\n').trim(), sections: sections.map((s) => ({ heading: s.heading, body: s.lines.join('\n').trim() })) }
}

/**
 * The 1-based line of the `index`th H2 section `splitDoc` found, matching its heading, so the editor
 * can reveal it; any line with that heading when the count has moved on, else null.
 */
export function headingLine(text: string, heading: string, index: number): number | null {
  let inFence = false
  let seen = -1
  let any: number | null = null
  for (const [at, line] of text.split('\n').entries()) {
    if (FENCE.test(line)) inFence = !inFence
    const h2 = inFence ? null : H2.exec(line)
    if (!h2?.[1]) continue
    seen += 1
    if (h2[1] !== heading) continue
    if (seen === index) return at + 1
    any ??= at + 1
  }
  return any
}

/** A heading as plain text: inline code and emphasis marks dropped. */
export function plainHeading(heading: string): string {
  return heading.replace(/`([^`]*)`/g, '$1').replace(/(\*\*|__|\*|_)(\S(?:.*?\S)?)\1/g, '$2')
}

/** A heading as GitHub anchors it: lower case, punctuation dropped, spaces as hyphens. */
export function headingSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-')
}

/** A markdown link to a section of a doc in the docs repo, for pasting into another doc or a ticket. */
export function sectionLink(path: string, heading: string): string {
  return `[${heading}](${path}#${headingSlug(heading)})`
}

/** One line of Context coverage: whether the map's docs cover it, and the roles that do. */
export interface CoverageLine {
  label: string
  covered: boolean
  roles: readonly DocRole[]
}

/** The kinds of context an agent works best with, each covered once a doc of the map carries every one of its roles. */
const COVERAGE: readonly { label: string; roles: readonly DocRole[] }[] = [
  { label: 'Product & technical plan', roles: ['product', 'technical'] },
  { label: 'Release guidance', roles: ['release'] },
  { label: 'Design reference', roles: ['design'] }
]

export function docCoverage(docs: readonly MapDocInfo[]): CoverageLine[] {
  const present = new Set(docs.flatMap((d) => d.roles))
  return COVERAGE.map((line) => ({ ...line, covered: line.roles.every((r) => present.has(r)) }))
}

export const ROLE_LABEL: Record<DocRole, string> = { product: 'Product', design: 'Design', technical: 'Technical', decision: 'Decision', release: 'Release' }

/** Roles in the order the page lists them: what to build, then how, then what it looks like and how it ships. */
export const ROLE_ORDER: readonly DocRole[] = ['product', 'technical', 'design', 'release', 'decision']

/** The role filters the docs list offers: the roles its docs carry. */
export function roleFilters(docs: readonly MapDocInfo[]): DocRole[] {
  return ROLE_ORDER.filter((role) => docs.some((d) => d.roles.includes(role)))
}

/** Whether a doc matches the search: its title, path or link address, ignoring case. */
export function docMatches(doc: MapDocInfo, search: string): boolean {
  const needle = search.trim().toLowerCase()
  if (!needle) return true
  return [doc.title, doc.path, doc.link?.url ?? ''].some((field) => field.toLowerCase().includes(needle))
}

/** Tickets whose context cites the doc, whole or a section of it. */
export function citingTickets(map: Pick<MapDetail, 'milestones'>, path: string): MapDetail['milestones'][number]['tickets'] {
  return map.milestones.flatMap((m) => m.tickets).filter((t) => t.docs.some((d) => d.path === path))
}
