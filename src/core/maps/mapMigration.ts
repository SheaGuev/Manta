import { cleanDocPath, type MapFile } from './mapModel'

/** `map.json` of a map from before v2: an id, title, about and creation date. */
export interface LegacyMap {
  id: string
  title: string
  about: string
  createdAt: string
}

export function parseLegacyMap(value: unknown): LegacyMap | null {
  if (typeof value !== 'object' || value === null || ('version' in value && value.version === 2)) return null
  if (!('id' in value) || typeof value.id !== 'string') return null
  if (!('title' in value) || typeof value.title !== 'string') return null
  if (!('createdAt' in value) || typeof value.createdAt !== 'string') return null
  return { id: value.id, title: value.title, about: 'about' in value && typeof value.about === 'string' ? value.about : '', createdAt: value.createdAt }
}

const H2 = /^##[ \t]+(.+?)\s*#*\s*$/
const ITEM = /^\s*[-*+][ \t]+(.*)$/
/** Spaces are allowed in the target, which CommonMark doesn't: v1 agents wrote `#Magic links`. */
const LINK = /\[[^\]]*\]\(([^)"]+?)(?:\s+"[^"]*")?\)/
const EXTERNAL = /^(https?|mailto|thread):/i

/** The doc paths a v1 `map.md` listed under `## Docs`, once each, in order. */
export function legacyDocs(markdown: string): string[] {
  const docs: string[] = []
  let inDocs = false
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) continue
    const heading = H2.exec(line)?.[1]
    if (heading !== undefined) {
      inDocs = heading.trim().toLowerCase() === 'docs'
      continue
    }
    if (/^#[ \t]/.test(line)) inDocs = false
    const item = inDocs ? ITEM.exec(line)?.[1] : undefined
    const target = item === undefined ? undefined : LINK.exec(item)?.[1]
    if (target === undefined || EXTERNAL.test(target)) continue
    const hash = target.indexOf('#')
    const doc = cleanDocPath(decode(hash === -1 ? target : target.slice(0, hash)))
    if (doc && !docs.includes(doc)) docs.push(doc)
  }
  return docs
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** A v1 map as v2: title and about become title and description, and its docs are listed with no milestone. Threads, code and stages are dropped. */
export function migrateLegacy(legacy: LegacyMap, mapMarkdown: string | null): MapFile {
  return {
    version: 2,
    id: legacy.id,
    title: legacy.title,
    description: legacy.about,
    createdAt: legacy.createdAt,
    projects: [],
    launchMode: 'ticket',
    sweep: true,
    confirmProposals: 'ask',
    pinned: null,
    checks: [],
    docs: legacyDocs(mapMarkdown ?? '').map((path) => ({ path, milestones: [], section: null, roles: [] })),
    sections: [],
    key: null,
    stage: null
  }
}
