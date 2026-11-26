export interface CachedReadOptions {
  /** A stale read waits until this long after the previous load started, so a burst of changes costs one or two loads. */
  minGapMs: number
  now?: () => number
}

/**
 * A value loaded on demand and kept until `invalidate`. Readers during a load share it; a reader
 * that arrives after an invalidation made mid-load gets a fresh load once the current one ends, so
 * a change is never answered with data read before it.
 */
export class CachedRead<T> {
  private value: { data: T } | null = null
  private stale = true
  /** Set when a load starts reading, so invalidations after that point are known to be newer. */
  private reading = false
  private loading: Promise<T> | null = null
  private queued: Promise<T> | null = null
  private lastStart = Number.NEGATIVE_INFINITY
  private wake: (() => void) | null = null
  private readonly now: () => number

  constructor(
    private readonly load: () => Promise<T>,
    private readonly options: CachedReadOptions
  ) {
    this.now = options.now ?? Date.now
  }

  /** The last loaded value, or null before the first load. */
  get last(): T | null {
    return this.value ? this.value.data : null
  }

  /** `urgent`: the user just changed something here, so the next load doesn't wait out the gap. */
  invalidate(urgent = false): void {
    this.stale = true
    if (!urgent) return
    this.lastStart = Number.NEGATIVE_INFINITY
    this.wake?.()
  }

  read(): Promise<T> {
    if (this.value && !this.stale) return Promise.resolve(this.value.data)
    if (!this.loading) return this.start()
    if (!this.reading) return this.loading
    this.queued ??= this.loading
      .catch(() => undefined)
      .then(() => {
        this.queued = null
        return this.read()
      })
    return this.queued
  }

  private start(): Promise<T> {
    this.loading = this.run().finally(() => {
      this.loading = null
      this.reading = false
    })
    return this.loading
  }

  private async run(): Promise<T> {
    const wait = this.lastStart + this.options.minGapMs - this.now()
    if (wait > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait)
        this.wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.wake = null
    }
    this.lastStart = this.now()
    this.stale = false
    this.reading = true
    try {
      const data = await this.load()
      this.value = { data }
      return data
    } catch (error) {
      this.stale = true
      throw error
    }
  }
}
