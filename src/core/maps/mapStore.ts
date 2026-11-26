import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MapBatch, MapEvent, MapLaunch, MapSuggestion, ThreadMessage } from '../../shared/ipc'
import { parseMapEvent } from './mapActivity'
import { isMessage } from '../threads/threads'
import { LAUNCH_ID, MAP_ID, MAPS_DIR, parseBatch, parseLaunch, parseMapFile, parseSuggestion, parseTracker, type MapFile, type Tracker } from './mapModel'

/** This machine's state of a map: Ask the map's session and conversation, and the user's visits. */
export interface MapState {
  session: string | null
  messages: ThreadMessage[]
  /** When the current visit started; null before the first. */
  visitedAt: string | null
  /** When the visit before it started. */
  lastVisitedAt: string | null
  /** When the user last marked the activity as seen. */
  seenAt: string | null
}

const MAP_FILE = 'map.json'
const TRACKER_FILE = 'tracker.json'
const STATE_FILE = 'state.json'
const LAUNCHES_FILE = 'launches.json'
const SUGGESTIONS_FILE = 'suggestions.json'
const BATCHES_FILE = 'batches.json'
const JOURNALS_DIR = 'journals'
const ACTIVITY_FILE = 'activity.jsonl'
const EMPTY_STATE: MapState = { session: null, messages: [], visitedAt: null, lastVisitedAt: null, seenAt: null }

/**
 * Context maps in the docs repo: `map.json`, `tracker.json` and the launches' journals in
 * `.manta/maps/<id>/` (kept out of git like thread records, and shared later with `.manta/`: none of
 * it is machine-specific), and this machine's state in `.git/manta/maps/<id>/`: launches,
 * suggestions waiting for review, Ask the map's conversation. Unreadable maps are skipped so one bad file can't hide the rest. Callers run
 * writes on the workspace's serial queue.
 */
export class MapStore {
  readonly dir: string

  constructor(
    repoRoot: string,
    private readonly localDir: string
  ) {
    this.dir = path.join(repoRoot, MAPS_DIR)
  }

  /** Ids of every map folder, readable or not. */
  async ids(): Promise<string[]> {
    return (await readdir(this.dir).catch(() => [])).filter((name) => MAP_ID.test(name))
  }

  async list(): Promise<MapFile[]> {
    const maps: MapFile[] = []
    for (const id of await this.ids()) {
      const map = await this.map(id)
      if (map) maps.push(map)
    }
    return maps.sort((a, b) => a.title.localeCompare(b.title) || a.createdAt.localeCompare(b.createdAt))
  }

  async map(id: string): Promise<MapFile | null> {
    const map = parseMapFile(await this.json(path.join(this.folder(id), MAP_FILE)))
    return map?.id === id ? map : null
  }

  /** `map.json` as stored, for maps from before v2. */
  raw(id: string, file: string = MAP_FILE): Promise<unknown> {
    return this.json(path.join(this.folder(id), file))
  }

  async writeMap(map: MapFile): Promise<void> {
    await writeIfChanged(path.join(this.folder(map.id), MAP_FILE), `${JSON.stringify(map, null, 2)}\n`)
  }

  async tracker(id: string): Promise<Tracker> {
    return parseTracker(await this.json(path.join(this.folder(id), TRACKER_FILE)))
  }

  async writeTracker(id: string, tracker: Tracker): Promise<void> {
    await writeIfChanged(path.join(this.folder(id), TRACKER_FILE), `${JSON.stringify(tracker, null, 2)}\n`)
  }

  async state(id: string): Promise<MapState> {
    const value = await this.json(path.join(this.localFolder(id), STATE_FILE))
    if (typeof value !== 'object' || value === null) return EMPTY_STATE
    const session = 'session' in value && typeof value.session === 'string' ? value.session : null
    const messages = 'messages' in value && Array.isArray(value.messages) ? value.messages.filter(isMessage) : []
    const visitedAt = 'visitedAt' in value && typeof value.visitedAt === 'string' ? value.visitedAt : null
    const lastVisitedAt = 'lastVisitedAt' in value && typeof value.lastVisitedAt === 'string' ? value.lastVisitedAt : null
    const seenAt = 'seenAt' in value && typeof value.seenAt === 'string' ? value.seenAt : null
    return { session, messages, visitedAt, lastVisitedAt, seenAt }
  }

  async saveState(id: string, state: MapState): Promise<void> {
    await writeIfChanged(path.join(this.localFolder(id), STATE_FILE), `${JSON.stringify(state)}\n`)
  }

  async launches(id: string): Promise<MapLaunch[]> {
    const value = await this.json(path.join(this.localFolder(id), LAUNCHES_FILE))
    return Array.isArray(value) ? value.flatMap((launch) => parseLaunch(launch) ?? []) : []
  }

  async writeLaunches(id: string, launches: readonly MapLaunch[]): Promise<void> {
    await writeIfChanged(path.join(this.localFolder(id), LAUNCHES_FILE), `${JSON.stringify(launches, null, 2)}\n`)
  }

  async batches(id: string): Promise<MapBatch[]> {
    const value = await this.json(path.join(this.localFolder(id), BATCHES_FILE))
    return Array.isArray(value) ? value.flatMap((batch) => parseBatch(batch) ?? []) : []
  }

  async writeBatches(id: string, batches: readonly MapBatch[]): Promise<void> {
    await writeIfChanged(path.join(this.localFolder(id), BATCHES_FILE), `${JSON.stringify(batches, null, 2)}\n`)
  }

  async suggestions(id: string): Promise<MapSuggestion[]> {
    const value = await this.json(path.join(this.localFolder(id), SUGGESTIONS_FILE))
    return Array.isArray(value) ? value.flatMap((suggestion) => parseSuggestion(suggestion) ?? []) : []
  }

  async writeSuggestions(id: string, suggestions: readonly MapSuggestion[]): Promise<void> {
    await writeIfChanged(path.join(this.localFolder(id), SUGGESTIONS_FILE), `${JSON.stringify(suggestions, null, 2)}\n`)
  }

  async journal(id: string, launch: string): Promise<string> {
    return readFile(this.journalFile(id, launch), 'utf8').catch(() => '')
  }

  /** Appends to a launch's journal: an append-only log, so a crash mid-write loses at most the entry being written. */
  async appendJournal(id: string, launch: string, entry: string): Promise<void> {
    const file = this.journalFile(id, launch)
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, entry)
  }

  /** The map's activity log, oldest first; null when it has none yet. A line that doesn't parse (one cut short by a crash) is skipped. */
  async activity(id: string): Promise<MapEvent[] | null> {
    const raw = await readFile(path.join(this.folder(id), ACTIVITY_FILE), 'utf8').catch(() => null)
    if (raw === null) return null
    return raw.split('\n').flatMap((line) => {
      if (!line.trim()) return []
      try {
        return parseMapEvent(JSON.parse(line)) ?? []
      } catch {
        return []
      }
    })
  }

  /** Appends to the activity log, creating it (empty, when given no events) if it isn't there. */
  async appendActivity(id: string, events: readonly MapEvent[]): Promise<void> {
    const file = path.join(this.folder(id), ACTIVITY_FILE)
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''))
  }

  /** Journals used to be kept with this machine's state; moves any left there into the map's folder. */
  async moveLocalJournals(id: string): Promise<void> {
    const from = path.join(this.localFolder(id), JOURNALS_DIR)
    const names = (await readdir(from).catch(() => [])).filter((name) => LAUNCH_ID.test(name.replace(/\.md$/, '')))
    if (names.length === 0) return
    const to = path.join(this.folder(id), JOURNALS_DIR)
    await mkdir(to, { recursive: true })
    for (const name of names) {
      const moved = await readFile(path.join(from, name), 'utf8')
      const kept = await readFile(path.join(to, name), 'utf8').catch(() => '')
      await writeFile(path.join(to, name), moved + kept)
      await rm(path.join(from, name), { force: true })
    }
  }

  /** Renames a file of the map's folder, e.g. `map.md` to `map.v1.md`; nothing when it isn't there. */
  async keepAs(id: string, from: string, to: string): Promise<void> {
    await rename(path.join(this.folder(id), from), path.join(this.folder(id), to)).catch(() => undefined)
  }

  async text(id: string, file: string): Promise<string | null> {
    return readFile(path.join(this.folder(id), file), 'utf8').catch(() => null)
  }

  async remove(id: string): Promise<void> {
    await rm(this.folder(id), { recursive: true, force: true })
    await rm(this.localFolder(id), { recursive: true, force: true })
  }

  /** The map's folder in the docs repo. */
  folder(id: string): string {
    if (!MAP_ID.test(id)) throw new Error(`Invalid map id ${id}`)
    return path.join(this.dir, id)
  }

  journalFile(id: string, launch: string): string {
    if (!LAUNCH_ID.test(launch)) throw new Error(`Invalid launch id ${launch}`)
    return path.join(this.folder(id), JOURNALS_DIR, `${launch}.md`)
  }

  private localFolder(id: string): string {
    if (!MAP_ID.test(id)) throw new Error(`Invalid map id ${id}`)
    return path.join(this.localDir, id)
  }

  private async json(file: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return null
    }
  }
}

async function writeIfChanged(file: string, text: string): Promise<boolean> {
  if ((await readFile(file, 'utf8').catch(() => null)) === text) return false
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(`${file}.tmp`, text)
  await rename(`${file}.tmp`, file)
  return true
}
