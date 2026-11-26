import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseRecord, type ThreadRecord } from './threads'

/**
 * Manta's own folder in the docs repo. Kept out of git (`info/exclude`) and out of the user's commits:
 * Manta stores what's in it, and sharing it is its job, not the user's.
 */
export const MANTA_DIR = '.manta'

export const THREADS_DIR = path.join(MANTA_DIR, 'threads')

const ID = /^t_[a-z0-9]+$/

/**
 * Thread records in the docs repo under `.manta/threads/<id>.json`: a plain-JSON export of each
 * thread that outlives the local CRDT state in `.git/manta/`. Not committed; see `MANTA_DIR`.
 */
export class ThreadRecordStore {
  private readonly dir: string

  constructor(repoRoot: string) {
    this.dir = path.join(repoRoot, THREADS_DIR)
  }

  /** Every readable record. Unparseable files are skipped so one bad file can't block the repo. */
  async list(): Promise<ThreadRecord[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const records: ThreadRecord[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const record = await this.read(name.slice(0, -'.json'.length))
      if (record) records.push(record)
      else console.error(`manta: skipping unreadable thread record ${path.join(THREADS_DIR, name)}`)
    }
    return records
  }

  async read(id: string): Promise<ThreadRecord | null> {
    if (!ID.test(id)) return null
    try {
      const record = parseRecord(JSON.parse(await readFile(this.fileFor(id), 'utf8')))
      return record?.id === id ? record : null
    } catch {
      return null
    }
  }

  /** Writes the record unless the file already holds exactly it. Returns true when it wrote. */
  async write(record: ThreadRecord): Promise<boolean> {
    if (!ID.test(record.id)) throw new Error(`Invalid thread id ${record.id}`)
    const json = `${JSON.stringify(record, null, 2)}\n`
    const file = this.fileFor(record.id)
    const current = await readFile(file, 'utf8').catch(() => null)
    if (current === json) return false
    await mkdir(this.dir, { recursive: true })
    await writeFile(`${file}.tmp`, json)
    await rename(`${file}.tmp`, file)
    return true
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`)
  }
}
