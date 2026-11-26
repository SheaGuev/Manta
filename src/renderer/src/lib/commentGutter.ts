import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { BlockType, Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter } from '@codemirror/view'
import type { ReviewComment } from '../../../shared/ipc'
import {
  deletedRowAnchor,
  deletedRowCount,
  deletedRowLine,
  newLineAnchor,
  placeComments,
  placeThreads,
  type LineAnchor,
  type PlacedComment,
  type ThreadNote
} from './reviewAnchors'

/** A button in the comment box; the accent one is what ⌘Enter does. */
export interface BoxAction {
  id: string
  label: string
  accent: boolean
}

export interface CommentHandlers {
  /**
   * `action` is a box action's id, or 'send' for the send icon; `rect` is the button pressed, for a picker.
   * Resolves whether it went through: the box closes then, and otherwise stays open with its text.
   */
  onSave: (anchor: LineAnchor, body: string, action: string, rect: DOMRect | null) => Promise<boolean>
  onRemove: (id: string) => void
  /** Read when a box opens. */
  actions: () => readonly BoxAction[]
  /** Lines that can't take a comment get no +; every line can when it's absent. */
  canComment?: (side: 'old' | 'new', line: number) => boolean
  /** The send icon's tooltip, since what it does besides sending differs by owner. */
  sendTitle: string
}

/** The saved comments for this diff's file; the view's owner dispatches it whenever they change. */
export const setReviewComments = StateEffect.define<readonly ReviewComment[]>()

/** Existing review threads for this diff's file, shown read-only under their lines. */
export const setThreadNotes = StateEffect.define<readonly ThreadNote[]>()

/** A line of the current file, or a row of the deleted lines drawn at `chunkFromB`. */
type Target = { line: number } | { chunkFromB: number; row: number }

/** A comment box being written: its anchor and where its widget sits. */
interface Draft {
  anchor: LineAnchor
  pos: number
  before: boolean
}

const setHover = StateEffect.define<Target | null>()
const setDraft = StateEffect.define<Draft | null>()

const commentsField = StateField.define<readonly ReviewComment[]>({
  create: () => [],
  update: (comments, tr) => tr.effects.reduce((value, effect) => (effect.is(setReviewComments) ? effect.value : value), comments)
})

const threadsField = StateField.define<readonly ThreadNote[]>({
  create: () => [],
  update: (notes, tr) => tr.effects.reduce((value, effect) => (effect.is(setThreadNotes) ? effect.value : value), notes)
})

const hoverField = StateField.define<Target | null>({
  create: () => null,
  update(hover, tr) {
    const set = tr.effects.findLast((effect) => effect.is(setHover))
    return set ? set.value : tr.docChanged ? null : hover
  }
})

const draftField = StateField.define<Draft | null>({
  create: () => null,
  update(draft, tr) {
    const set = tr.effects.findLast((effect) => effect.is(setDraft))
    if (set) return set.value
    return draft && tr.docChanged ? { ...draft, pos: tr.changes.mapPos(draft.pos) } : draft
  }
})

const sameTarget = (a: Target | null, b: Target | null): boolean =>
  a === b || (a !== null && b !== null && ('line' in a ? 'line' in b && a.line === b.line : 'row' in b && a.chunkFromB === b.chunkFromB && a.row === b.row))

/** Widgets of ours, so the gutter and hover tell them from the merge view's deletion widgets. */
abstract class ReviewWidget extends WidgetType {
  override ignoreEvent(): boolean {
    return true
  }
}

/** CodeMirror measures a block widget without its margins, so the spacing is the wrapper's padding. */
function wrapped(card: HTMLElement): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'cm-reviewWidget'
  wrapper.appendChild(card)
  return wrapper
}

const SEND_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>'

function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button')
  element.className = className
  element.textContent = label
  /** Keeps focus in the comment box and the editor's cursor where it was. */
  element.addEventListener('mousedown', (event) => event.preventDefault())
  element.addEventListener('click', onClick)
  return element
}

class CommentBoxWidget extends ReviewWidget {
  constructor(
    readonly draft: Draft,
    readonly handlers: { current: CommentHandlers }
  ) {
    super()
  }

  /** Same anchor, same box: the text typed so far survives a redraw. */
  override eq(other: CommentBoxWidget): boolean {
    return other.draft.anchor.side === this.draft.anchor.side && other.draft.anchor.line === this.draft.anchor.line
  }

  toDOM(view: EditorView): HTMLElement {
    const { anchor } = this.draft
    const dom = document.createElement('div')
    dom.className = 'cm-commentBox'
    const text = dom.appendChild(document.createElement('textarea'))
    text.rows = 3
    text.placeholder = anchor.side === 'old' ? `Comment on removed line ${anchor.line}` : `Comment on line ${anchor.line}`
    const close = (): void => view.dispatch({ effects: setDraft.of(null) })
    const save = (action: string, pressed: HTMLElement | null): void => {
      const body = text.value.trim()
      if (!body) return text.focus()
      const buttons = [...actions.querySelectorAll('button')]
      for (const b of buttons) b.disabled = true
      void this.handlers.current.onSave(anchor, body, action, pressed ? pressed.getBoundingClientRect() : null).then((done) => {
        /** The view may have gone, or another box opened, while it was saving. */
        if (!view.dom.isConnected || view.state.field(draftField)?.anchor !== anchor) return
        if (done) return close()
        for (const b of buttons) b.disabled = false
        text.focus()
      })
    }
    const boxActions = this.handlers.current.actions()
    const main = boxActions.find((action) => action.accent) ?? boxActions.at(-1)
    const actions = dom.appendChild(document.createElement('div'))
    actions.className = 'cm-commentBox-actions'
    const sendButton = actions.appendChild(button('icon-button', '', () => save('send', sendButton)))
    sendButton.innerHTML = SEND_ICON
    sendButton.title = this.handlers.current.sendTitle
    actions.appendChild(button('primary-button small', 'Cancel', close))
    for (const action of boxActions) {
      const pressed = actions.appendChild(button(`primary-button small${action.accent ? ' accent' : ''}`, action.label, () => save(action.id, pressed)))
    }
    text.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close()
      else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && main) save(main.id, null)
      else return
      event.preventDefault()
    })
    requestAnimationFrame(() => text.focus())
    return wrapped(dom)
  }
}

class SavedCommentWidget extends ReviewWidget {
  constructor(
    readonly placed: PlacedComment,
    readonly handlers: { current: CommentHandlers }
  ) {
    super()
  }

  override eq(other: SavedCommentWidget): boolean {
    const a = this.placed
    const b = other.placed
    return a.comment.id === b.comment.id && a.comment.body === b.comment.body && a.comment.sent?.to === b.comment.sent?.to && a.outdated === b.outdated
  }

  toDOM(): HTMLElement {
    const { comment, outdated } = this.placed
    const dom = document.createElement('div')
    dom.className = `cm-reviewComment${comment.sent ? ' sent' : ''}`
    const body = dom.appendChild(document.createElement('div'))
    body.className = 'cm-reviewComment-body'
    body.textContent = comment.body
    const meta = dom.appendChild(document.createElement('div'))
    meta.className = 'cm-reviewComment-meta'
    if (outdated) {
      const badge = meta.appendChild(document.createElement('span'))
      badge.className = 'badge'
      badge.textContent = 'outdated'
      badge.title = 'The line changed since this comment was made'
    }
    if (comment.diff.startsWith('pr:')) meta.appendChild(document.createElement('span')).textContent = 'pending'
    else if (comment.sent) meta.appendChild(document.createElement('span')).textContent = `sent to ${comment.sent.to}`
    const remove = meta.appendChild(button('icon-button', '×', () => this.handlers.current.onRemove(comment.id)))
    remove.title = 'Delete comment'
    return wrapped(dom)
  }
}

/** A GitHub review thread: who started it, what they said, how many replied, and a link to it. */
class ThreadNoteWidget extends ReviewWidget {
  constructor(readonly note: ThreadNote) {
    super()
  }

  override eq(other: ThreadNoteWidget): boolean {
    return other.note.id === this.note.id && other.note.body === this.note.body && other.note.replies === this.note.replies
  }

  toDOM(): HTMLElement {
    const { note } = this
    const dom = document.createElement('div')
    dom.className = 'cm-threadNote'
    const head = dom.appendChild(document.createElement('div'))
    head.className = 'cm-threadNote-head'
    head.appendChild(document.createElement('span')).textContent = `@${note.author}`
    if (note.replies > 0) {
      const replies = head.appendChild(document.createElement('span'))
      replies.className = 'cm-threadNote-replies'
      replies.textContent = note.replies === 1 ? '1 reply' : `${note.replies} replies`
    }
    const link = head.appendChild(document.createElement('a'))
    link.className = 'cm-threadNote-link'
    link.href = note.url
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.textContent = 'Open on GitHub'
    const body = dom.appendChild(document.createElement('div'))
    body.className = 'cm-threadNote-body'
    body.textContent = note.body
    return wrapped(dom)
  }
}

function openDraft(view: EditorView, target: Target): void {
  const { state } = view
  const draft =
    'line' in target
      ? { anchor: newLineAnchor(state, target.line), pos: state.doc.line(target.line).to, before: false }
      : (() => {
          const anchor = deletedRowAnchor(state, target.chunkFromB, target.row)
          return anchor ? { anchor, pos: target.chunkFromB, before: true } : null
        })()
  if (draft) view.dispatch({ effects: setDraft.of(draft) })
}

class PlusMarker extends GutterMarker {
  constructor(readonly target: Target) {
    super()
  }

  override eq(other: PlusMarker): boolean {
    return sameTarget(this.target, other.target)
  }

  override toDOM(view: EditorView): Node {
    return plus(view, this.target)
  }
}

function plus(view: EditorView, target: Target): HTMLElement {
  const element = document.createElement('div')
  element.className = 'cm-commentPlus'
  element.textContent = '+'
  element.title = 'Comment on this line'
  element.addEventListener('mousedown', (event) => event.preventDefault())
  element.addEventListener('click', () => openDraft(view, target))
  return element
}

/** One row per deleted line beside the merge view's deletion widget, with a + on the hovered one. */
class DeletedRowsMarker extends GutterMarker {
  constructor(
    readonly chunkFromB: number,
    readonly rows: number,
    readonly hovered: number
  ) {
    super()
  }

  override eq(other: DeletedRowsMarker): boolean {
    return other.chunkFromB === this.chunkFromB && other.rows === this.rows && other.hovered === this.hovered
  }

  override toDOM(view: EditorView): Node {
    const dom = document.createElement('div')
    for (let row = 0; row < this.rows; row++) {
      const element = dom.appendChild(document.createElement('div'))
      element.className = 'cm-commentRow'
      element.style.height = `${view.defaultLineHeight}px`
      if (row === this.hovered) element.appendChild(plus(view, { chunkFromB: this.chunkFromB, row }))
    }
    return dom
  }
}

/** The line or deleted row under the pointer, gutter included; null over our own widgets. */
function targetAt(view: EditorView, event: MouseEvent): Target | null {
  if (event.target instanceof Element && event.target.closest('.cm-commentBox, .cm-reviewComment, .cm-threadNote')) return null
  const height = event.clientY - view.documentTop
  const block = view.elementAtHeight(height)
  const { doc } = view.state
  if (block.type === BlockType.Text) {
    const line = doc.lineAt(block.from)
    /** The empty line after a final newline isn't a line of the diff. */
    return line.number === doc.lines && line.length === 0 && doc.lines > 1 ? null : { line: line.number }
  }
  if (!block.widget || block.widget instanceof ReviewWidget) return null
  const row = Math.floor((height - block.top) / view.defaultLineHeight)
  return row >= 0 && row < deletedRowCount(view.state, block.from) ? { chunkFromB: block.from, row } : null
}

function commentable(state: EditorState, target: Target, canComment: CommentHandlers['canComment']): boolean {
  if (!canComment) return true
  if ('line' in target) return canComment('new', target.line)
  const line = deletedRowLine(state, target.chunkFromB, target.row)
  return line !== null && canComment('old', line)
}

/** DOM listeners run outside CodeMirror's updates, so they dispatch directly. */
const hoverTracker = (handlers: { current: CommentHandlers }) =>
  ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {
        view.dom.addEventListener('mousemove', this.move)
        view.dom.addEventListener('mouseleave', this.leave)
      }

      move = (event: MouseEvent): void => {
        const target = targetAt(this.view, event)
        this.hover(target && commentable(this.view.state, target, handlers.current.canComment) ? target : null)
      }
      leave = (): void => this.hover(null)

      hover(target: Target | null): void {
        if (!sameTarget(target, this.view.state.field(hoverField))) this.view.dispatch({ effects: setHover.of(target) })
      }

      destroy(): void {
        this.view.dom.removeEventListener('mousemove', this.move)
        this.view.dom.removeEventListener('mouseleave', this.leave)
      }
    }
  )

/** Below a deletion's rows (side -1) and above the line there; new-side widgets follow their line. GitHub's threads come first, then saved comments, then a box being written. */
const SIDE = { threadBefore: -0.8, savedBefore: -0.6, draftBefore: -0.3, threadAfter: 0.5, savedAfter: 1, draftAfter: 2 }

function decorations(state: EditorState, handlers: { current: CommentHandlers }) {
  const ranges: Range<Decoration>[] = placeThreads(state, state.field(threadsField)).map((placed) =>
    Decoration.widget({ widget: new ThreadNoteWidget(placed.note), block: true, side: placed.before ? SIDE.threadBefore : SIDE.threadAfter }).range(placed.pos)
  )
  for (const placed of placeComments(state, state.field(commentsField))) {
    ranges.push(Decoration.widget({ widget: new SavedCommentWidget(placed, handlers), block: true, side: placed.before ? SIDE.savedBefore : SIDE.savedAfter }).range(placed.pos))
  }
  const draft = state.field(draftField)
  if (draft) ranges.push(Decoration.widget({ widget: new CommentBoxWidget(draft, handlers), block: true, side: draft.before ? SIDE.draftBefore : SIDE.draftAfter }).range(draft.pos))
  return Decoration.set(ranges, true)
}

/**
 * Review comments in a unified merge view: a + in a gutter beside the hovered line or deleted row
 * opens a comment box under it, and saved comments show under their line. Handlers are read
 * through a ref so new callbacks don't rebuild the view.
 */
export function commentGutter(handlers: { current: CommentHandlers }): Extension {
  return [
    commentsField,
    threadsField,
    hoverField,
    draftField,
    hoverTracker(handlers),
    EditorView.decorations.compute(['doc', commentsField, threadsField, draftField], (state) => decorations(state, handlers)),
    gutter({
      class: 'cm-commentGutter',
      lineMarker(view, line) {
        const hover = view.state.field(hoverField)
        return hover && 'line' in hover && view.state.doc.lineAt(line.from).number === hover.line ? new PlusMarker(hover) : null
      },
      widgetMarker(view, widget, block) {
        if (widget instanceof ReviewWidget) return null
        const rows = deletedRowCount(view.state, block.from)
        if (rows === 0) return null
        const hover = view.state.field(hoverField)
        return new DeletedRowsMarker(block.from, rows, hover && 'row' in hover && hover.chunkFromB === block.from ? hover.row : -1)
      },
      lineMarkerChange: (update) => update.startState.field(hoverField) !== update.state.field(hoverField)
    })
  ]
}
