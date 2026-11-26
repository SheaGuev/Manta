/**
 * Hidden terminals that still hold a WebGL context, least recently hidden first. Chromium drops the
 * oldest context past 16 per page, so hidden terminals over the cap give theirs up and draw with the
 * DOM renderer (free while hidden: xterm doesn't draw a terminal that isn't visible).
 */
export class HiddenWebglBudget {
  private readonly hidden: string[] = []

  constructor(private readonly max: number) {}

  /** Notes a terminal that hid holding a context; returns the terminals that must give theirs up. */
  hide(id: string): string[] {
    this.forget(id)
    this.hidden.push(id)
    return this.hidden.splice(0, Math.max(0, this.hidden.length - this.max))
  }

  /** The terminal is visible again, or gone. */
  forget(id: string): void {
    const index = this.hidden.indexOf(id)
    if (index >= 0) this.hidden.splice(index, 1)
  }
}
