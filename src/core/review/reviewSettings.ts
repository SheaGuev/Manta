import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_PR_TEMPLATE =
  'Analyse these PR comments, assign a reference to each like C1, C2, C3… Create a table with what can be addressed with your recommendations, split actionable items from items which require more thought.'

/**
 * The user's review settings, global rather than per repo: for now the prompt put in front of PR
 * comments sent to an agent. Until the user has confirmed it once, the default is offered unconfirmed.
 */
export class ReviewSettings {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  template(): Promise<{ text: string; confirmed: boolean }> {
    return this.enqueue(async () => {
      const saved = await this.read()
      return saved ? { text: saved, confirmed: true } : { text: DEFAULT_PR_TEMPLATE, confirmed: false }
    })
  }

  setTemplate(text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return Promise.reject(new Error('The prompt is empty'))
    return this.enqueue(async () => {
      await mkdir(path.dirname(this.file), { recursive: true })
      await writeFile(`${this.file}.tmp`, `${JSON.stringify({ prTemplate: trimmed }, null, 2)}\n`)
      await rename(`${this.file}.tmp`, this.file)
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** The saved template; null when there is none or the file can't be read. */
  private async read(): Promise<string | null> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8'))
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null || !('prTemplate' in parsed)) return null
    return typeof parsed.prTemplate === 'string' && parsed.prTemplate.trim() ? parsed.prTemplate : null
  }
}
