import { syntaxTree } from '@codemirror/language'
import { Prec, StateEffect, StateField, type EditorState, type Extension, type Range, type Text } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import type * as Y from 'yjs'
import { sectionAt, ThreadIndex } from '../../../core/threads/threads'
import type { TextRange, ThreadInfo, ThreadStatus } from '../../../shared/ipc'

export interface ThreadHandlers {
  onOpen: (thread: ThreadInfo) => void
  /** Start a thread on the section containing `offset`. */
  onCreate: (offset: number, title: string) => void
  /** Stop highlighting what an approved thread changed. */
  onDismiss: (thread: ThreadInfo) => void
  /** Start implementing the section containing `offset` in a code worktree. */
  onImplement?: (offset: number, title: string) => void
  /** Mark an implementation thread abandoned; its session and worktree are left alone. */
  onAbandon?: (thread: ThreadInfo) => void
}

/** The threads on one section, shown as one marker in the right margin of its first line. */
export interface SectionThreads {
  /** Start of the section's first line, where the marker sits. */
  line: number
  /** Threads that need the user: open or approved, or merged with their changes still highlighted. */
  active: ThreadInfo[]
  /** The section's other threads, newest first; listed in the popover only. */
  closed: ThreadInfo[]
  /** Status the marker shows: the most pressing one among `active`. */
  status: ThreadStatus
  /** The text the active threads cover, outlined while the marker is hovered. */
  range: TextRange
}

const STATUS_ORDER: readonly ThreadStatus[] = ['open', 'approved', 'merged', 'discarded']

/** What a thread's status reads as; an implementation thread is in progress, landed or abandoned. */
export function threadStatusLabel(thread: ThreadInfo): string {
  if (!thread.implementation) return thread.status
  if (thread.status === 'merged') return 'landed'
  if (thread.status === 'discarded') return 'abandoned'
  const { branch, pr } = thread.implementation
  const parts = ['implementing', branch.replace(/^manta\//, ''), ...(pr ? [`PR #${pr.number}${pr.state === 'open' ? '' : ` ${pr.state}`}`] : [])]
  return parts.filter(Boolean).join(' · ')
}

/** Whether a thread still asks for attention in the doc; everything else lives in the Threads panel. */
export function isActiveThread(thread: ThreadInfo): boolean {
  return thread.status === 'open' || thread.status === 'approved' || (thread.status === 'merged' && thread.highlighted)
}

/**
 * Groups the doc's top-level threads by the line their section starts on. Sections with no active
 * thread get no marker; detached threads and subthreads (reached through their parent) never do.
 */
export function sectionMarkers(index: ThreadIndex, doc: string, text: Text): SectionThreads[] {
  const byLine = new Map<number, { range: TextRange; thread: ThreadInfo }[]>()
  for (const thread of index.list(doc)) {
    if (!thread.range || thread.parent !== null) continue
    const range = { from: Math.min(thread.range.from, text.length), to: Math.min(thread.range.to, text.length) }
    const line = text.lineAt(range.from).from
    byLine.set(line, [...(byLine.get(line) ?? []), { range, thread }])
  }
  const sections: SectionThreads[] = []
  for (const [line, entries] of byLine) {
    const active = entries.filter((entry) => isActiveThread(entry.thread))
    const first = active[0]
    if (!first) continue
    const status = STATUS_ORDER.find((s) => active.some((entry) => entry.thread.status === s)) ?? first.thread.status
    sections.push({
      line,
      active: active.map((entry) => entry.thread),
      closed: entries.filter((entry) => !isActiveThread(entry.thread)).map((entry) => entry.thread),
      status,
      range: {
        from: Math.min(...active.map((entry) => entry.range.from)),
        to: Math.max(...active.map((entry) => entry.range.to))
      }
    })
  }
  return sections.sort((a, b) => a.line - b.line)
}

/**
 * Splits `from`–`to` into one span per line, without the line breaks. A mark that runs past a
 * line's end would wrap the change badge sitting there in the highlight.
 */
export function lineSegments(doc: Text, from: number, to: number): { from: number; to: number }[] {
  const segments: { from: number; to: number }[] = []
  for (let pos = from; pos < to; ) {
    const line = doc.lineAt(pos)
    const end = Math.min(to, line.to)
    if (end > pos) segments.push({ from: pos, to: end })
    pos = line.to + 1
  }
  return segments
}

/** A default thread title: the section's heading, or the start of the paragraph. */
export function sectionTitle(markdown: string, offset: number): string {
  const { from, to } = sectionAt(markdown, offset)
  const first = markdown.slice(from, to).split('\n')[0] ?? ''
  const title = first.replace(/^#{1,6}\s+/, '').trim()
  if (!title) return 'Thread'
  return title.length > 60 ? `${title.slice(0, 57)}…` : title
}

/** What a section marker does when used; the popover lives inside the marker's DOM. */
interface MarkerEvents {
  toggle: () => void
  hover: (range: TextRange | null) => void
  open: (thread: ThreadInfo) => void
  create: () => void
  implement: (() => void) | null
  /** Hides a landed implementation's chip. */
  hide: (thread: ThreadInfo) => void
  abandon: ((thread: ThreadInfo) => void) | null
}

class MarkerWidget extends WidgetType {
  constructor(
    readonly section: SectionThreads,
    readonly expanded: boolean,
    readonly events: MarkerEvents
  ) {
    super()
  }

  eq(other: MarkerWidget): boolean {
    const key = (s: SectionThreads): string => JSON.stringify([s.status, [...s.active, ...s.closed].map((t) => [t.id, t.title, threadStatusLabel(t)])])
    return other.expanded === this.expanded && key(other.section) === key(this.section)
  }

  toDOM(): HTMLElement {
    const { active, status } = this.section
    const marker = document.createElement('span')
    marker.className = 'cm-thread-marker'
    const button = document.createElement('span')
    const implementing = active.some((t) => t.implementation !== null)
    button.className = `cm-thread-marker-button ${status}${implementing ? ' implementation' : ''}`
    button.title = active.map((t) => `${t.title} · ${threadStatusLabel(t)}`).join('\n')
    const dot = document.createElement('span')
    dot.className = 'cm-thread-pill-dot'
    button.append(dot)
    if (active.length > 1) button.append(String(active.length))
    button.addEventListener('click', () => this.events.toggle())
    button.addEventListener('mouseenter', () => this.events.hover(this.section.range))
    button.addEventListener('mouseleave', () => this.events.hover(null))
    marker.append(button)
    if (this.expanded) marker.append(this.popover())
    marker.addEventListener('mousedown', (e) => e.preventDefault())
    return marker
  }

  private popover(): HTMLElement {
    const popover = document.createElement('div')
    popover.className = 'cm-thread-popover'
    const row = (thread: ThreadInfo): HTMLElement => {
      const item = document.createElement('div')
      item.className = `cm-thread-popover-row ${thread.status}${thread.implementation ? ' implementation' : ''}`
      const dot = document.createElement('span')
      dot.className = 'cm-thread-pill-dot'
      const title = document.createElement('span')
      title.className = 'cm-thread-popover-title'
      title.textContent = thread.title
      const status = document.createElement('span')
      status.className = 'cm-thread-popover-status'
      status.textContent = threadStatusLabel(thread)
      item.append(dot, title, status)
      item.addEventListener('click', () => this.events.open(thread))
      const action = this.implementationAction(thread)
      if (action) item.append(action)
      return item
    }
    popover.append(...this.section.active.map(row))
    const { closed } = this.section
    if (closed.length > 0) {
      const more = document.createElement('div')
      more.className = 'cm-thread-popover-more'
      more.textContent = `${closed.length} closed`
      more.addEventListener('click', () => more.replaceWith(...closed.map(row)))
      popover.append(more)
    }
    const add = document.createElement('div')
    add.className = 'cm-thread-popover-add'
    add.textContent = '+ New thread on this section'
    add.addEventListener('click', () => this.events.create())
    popover.append(add)
    const { implement } = this.events
    if (implement) {
      const start = document.createElement('div')
      start.className = 'cm-thread-popover-add'
      start.textContent = '▸ Implement this section…'
      start.addEventListener('click', () => implement())
      popover.append(start)
    }
    return popover
  }

  /** Hide on a landed implementation, Abandon on one in progress. */
  private implementationAction(thread: ThreadInfo): HTMLElement | null {
    if (!thread.implementation) return null
    const { abandon } = this.events
    const run = thread.status === 'merged' ? () => this.events.hide(thread) : thread.status === 'open' && abandon ? () => abandon(thread) : null
    if (!run) return null
    const action = document.createElement('span')
    action.className = 'cm-thread-popover-action'
    action.textContent = thread.status === 'merged' ? 'Hide' : 'Abandon'
    action.title = thread.status === 'merged' ? 'Stop showing this implementation as landed' : 'Mark this implementation abandoned; its session and worktree stay'
    action.addEventListener('click', (event) => {
      event.stopPropagation()
      run()
    })
    return action
  }

  ignoreEvent(): boolean {
    return true
  }
}

/** Text an approved thread removed, shown struck through where it was. */
class RemovedWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  eq(other: RemovedWidget): boolean {
    return other.text === this.text
  }

  toDOM(): HTMLElement {
    const removed = document.createElement('del')
    removed.className = 'cm-thread-removed'
    removed.textContent = this.text
    return removed
  }
}

/**
 * Sits at the end of the line holding a thread's first highlighted change, so the way back to the
 * thread and the way to dismiss the highlight are where the reader meets the change. A change can
 * span the whole doc; on its last line the badge would be out of sight.
 */
class ChangeBadgeWidget extends WidgetType {
  constructor(
    readonly thread: ThreadInfo,
    readonly open: () => void,
    readonly hide: () => void
  ) {
    super()
  }

  eq(other: ChangeBadgeWidget): boolean {
    return other.thread.id === this.thread.id && other.thread.title === this.thread.title
  }

  toDOM(): HTMLElement {
    const badge = document.createElement('span')
    badge.className = 'cm-thread-badge'
    const link = document.createElement('span')
    link.className = 'cm-thread-badge-link'
    link.textContent = `Changed by “${this.thread.title}”`
    link.title = 'Open the thread'
    link.addEventListener('click', () => this.open())
    const hide = document.createElement('span')
    hide.className = 'cm-thread-hide'
    hide.textContent = 'Hide changes'
    hide.title = 'Stop highlighting what this thread changed'
    hide.addEventListener('click', () => this.hide())
    badge.append(link, hide)
    badge.addEventListener('mousedown', (e) => e.preventDefault())
    return badge
  }

  ignoreEvent(): boolean {
    return true
  }
}

class AddWidget extends WidgetType {
  constructor(
    readonly create: () => void,
    readonly implement: (() => void) | null
  ) {
    super()
  }

  eq(other: AddWidget): boolean {
    return (other.implement === null) === (this.implement === null)
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.addEventListener('mousedown', (e) => e.preventDefault())
    const button = document.createElement('span')
    button.className = 'cm-thread-add'
    button.textContent = '+ thread'
    button.title = 'Start a thread on this section'
    button.addEventListener('click', () => this.create())
    wrap.append(button)
    const { implement } = this
    if (implement) {
      const start = document.createElement('span')
      start.className = 'cm-thread-implement'
      start.textContent = '▸ implement'
      start.title = 'Implement this section in a code worktree'
      start.addEventListener('click', () => implement())
      wrap.append(start)
    }
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

const refreshMarkers = StateEffect.define<null>()
const focusSection = StateEffect.define<TextRange | null>()
const togglePopover = StateEffect.define<number | null>()

/** The section line whose thread list is open, if any. */
const popoverLine = StateField.define<number | null>({
  create: () => null,
  update(line, tr) {
    for (const effect of tr.effects) if (effect.is(togglePopover)) return effect.value
    return line === null ? null : tr.changes.mapPos(line)
  }
})

/**
 * A marker in the right margin of each section with active threads, and a hover "+ thread" button
 * on headings. Markers come from the thread index in the editor's own Yjs
 * replica, so they follow every edit; the handlers are read through `handlers` so the editor
 * never rebuilds.
 */
export function threadMarkers(ydoc: Y.Doc, doc: string, handlers: { current: ThreadHandlers | undefined }): Extension {
  const index = new ThreadIndex(ydoc)

  const startAt = (view: EditorView, pos: number): void => {
    handlers.current?.onCreate(pos, sectionTitle(view.state.doc.toString(), pos))
  }
  const implementAt = (view: EditorView, pos: number): (() => void) | null =>
    handlers.current?.onImplement ? () => handlers.current?.onImplement?.(pos, sectionTitle(view.state.doc.toString(), pos)) : null

  const plugin = ViewPlugin.fromClass(
    class {
      markers: DecorationSet
      outline: DecorationSet = Decoration.none
      extras: DecorationSet
      private hovered: TextRange | null = null
      private readonly stop: () => void
      private live = true

      constructor(readonly view: EditorView) {
        this.markers = this.buildMarkers()
        this.extras = this.buildExtras(view.state)
        // The index changes outside CodeMirror (a thread created or approved in main). Refresh
        // after the Yjs transaction settles, never inside an editor update.
        const onChange = (): void => queueMicrotask(() => this.live && this.view.dispatch({ effects: refreshMarkers.of(null) }))
        index.map.observe(onChange)
        // A click anywhere outside the open popover closes it.
        const onMouseDown = (event: MouseEvent): void => {
          if (this.view.state.field(popoverLine) === null) return
          if (event.target instanceof Element && event.target.closest('.cm-thread-marker')) return
          this.view.dispatch({ effects: togglePopover.of(null) })
        }
        document.addEventListener('mousedown', onMouseDown)
        this.stop = () => {
          index.map.unobserve(onChange)
          document.removeEventListener('mousedown', onMouseDown)
        }
      }

      update(update: ViewUpdate): void {
        const effects = update.transactions.flatMap((tr) => tr.effects)
        for (const effect of effects) if (effect.is(focusSection)) this.hovered = effect.value
        // Text edits map the markers; the replica's text can lag CodeMirror inside an update.
        const rebuild = effects.some((e) => e.is(refreshMarkers) || e.is(togglePopover))
        this.markers = rebuild ? this.buildMarkers() : this.markers.map(update.changes)
        if (rebuild || effects.some((e) => e.is(focusSection))) this.outline = this.buildOutline()
        else this.outline = this.outline.map(update.changes)
        if (update.docChanged || update.viewportChanged) this.extras = this.buildExtras(update.state)
      }

      destroy(): void {
        this.live = false
        this.stop()
      }

      /** One marker per section with active threads, plus what each approved thread changed until hidden. */
      private buildMarkers(): DecorationSet {
        const text = this.view.state.doc
        const open = this.view.state.field(popoverLine)
        const ranges: Range<Decoration>[] = []
        for (const section of sectionMarkers(index, doc, text)) {
          const close = (): void => this.view.dispatch({ effects: togglePopover.of(null) })
          const widget = new MarkerWidget(section, section.line === open, {
            toggle: () => this.view.dispatch({ effects: togglePopover.of(section.line === open ? null : section.line) }),
            hover: (range) => this.view.dispatch({ effects: focusSection.of(range) }),
            open: (thread) => {
              close()
              handlers.current?.onOpen(thread)
            },
            create: () => {
              close()
              startAt(this.view, section.line)
            },
            implement: implementAt(this.view, section.line) && (() => {
              close()
              implementAt(this.view, section.line)?.()
            }),
            hide: (thread) => {
              close()
              handlers.current?.onDismiss(thread)
            },
            abandon: handlers.current?.onAbandon
              ? (thread) => {
                  close()
                  handlers.current?.onAbandon?.(thread)
                }
              : null
          })
          ranges.push(Decoration.widget({ widget, side: -1 }).range(section.line))
        }
        for (const thread of index.list(doc)) {
          if (thread.parent !== null) continue
          const changes = index.landed(thread.id).filter((change) => change.from <= text.length)
          if (changes.length === 0) continue
          for (const { from, to, removed } of changes) {
            if (removed) ranges.push(Decoration.widget({ widget: new RemovedWidget(removed), side: -1 }).range(from))
            const landed = Decoration.mark({ class: 'cm-thread-landed', attributes: { title: `Changed by the thread "${thread.title}"` } })
            for (const segment of lineSegments(text, from, Math.min(to, text.length))) {
              ranges.push(landed.range(segment.from, segment.to))
            }
          }
          const firstLine = text.lineAt(Math.min(...changes.map((change) => change.from)))
          const badge = new ChangeBadgeWidget(
            thread,
            () => handlers.current?.onOpen(thread),
            () => handlers.current?.onDismiss(thread)
          )
          ranges.push(Decoration.widget({ widget: badge, side: 2 }).range(firstLine.to))
        }
        return Decoration.set(ranges, true)
      }

      /** Outlines the hovered marker's section, or the one whose popover is open. */
      private buildOutline(): DecorationSet {
        const text = this.view.state.doc
        const open = this.view.state.field(popoverLine)
        const range = this.hovered ?? sectionMarkers(index, doc, text).find((section) => section.line === open)?.range ?? null
        if (!range || range.to <= range.from) return Decoration.none
        const lines: Range<Decoration>[] = []
        const last = text.lineAt(Math.min(range.to, text.length) - 1).number
        for (let n = text.lineAt(range.from).number; n <= last; n++) {
          lines.push(Decoration.line({ class: 'cm-thread-outline' }).range(text.line(n).from))
        }
        return Decoration.set(lines)
      }

      private buildExtras(state: EditorState): DecorationSet {
        const ranges: Range<Decoration>[] = []
        for (const { from, to } of this.view.visibleRanges) {
          syntaxTree(state).iterate({
            from,
            to,
            enter: (node) => {
              if (!/^ATXHeading\d$/.test(node.name)) return
              const line = state.doc.lineAt(node.from)
              const widget = new AddWidget(() => startAt(this.view, line.from), implementAt(this.view, line.from))
              ranges.push(Decoration.widget({ widget, side: 1 }).range(line.to))
              return false
            }
          })
        }
        return Decoration.set(ranges, true)
      }
    },
    {
      provide: (p) => [
        EditorView.decorations.of((view) => view.plugin(p)?.markers ?? Decoration.none),
        EditorView.decorations.of((view) => view.plugin(p)?.outline ?? Decoration.none),
        EditorView.decorations.of((view) => view.plugin(p)?.extras ?? Decoration.none)
      ]
    }
  )

  const popoverKeymap = Prec.high(
    keymap.of([
      {
        key: 'Escape',
        run: (view) => {
          if (view.state.field(popoverLine) === null) return false
          view.dispatch({ effects: togglePopover.of(null) })
          return true
        }
      }
    ])
  )

  return [popoverLine, plugin, popoverKeymap]
}
