import { ensureSyntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { parseTable, tokenizeInline } from './markdownTable'

export interface PreviewSpec {
  hidden: { from: number; to: number }[]
  marks: { from: number; to: number; className: string }[]
  lines: { from: number; className: string }[]
}

const INLINE_STYLE: Record<string, string> = {
  Emphasis: 'cm-md-em',
  StrongEmphasis: 'cm-md-strong',
  InlineCode: 'cm-md-code',
  Strikethrough: 'cm-md-strike',
  Link: 'cm-md-link',
  ListMark: 'cm-md-listmark'
}

const INLINE_MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'LinkMark', 'URL', 'LinkTitle'])

/**
 * What to hide and style for Obsidian-style live preview. Syntax marks are hidden everywhere
 * except on lines touched by a selection while the editor is focused.
 */
export function computePreview(state: EditorState, focused = true): PreviewSpec {
  const spec: PreviewSpec = { hidden: [], marks: [], lines: [] }
  // Parse budget per update. Long docs that need more get a partial tree now and the rest on
  // the next update, rather than blocking typing.
  const tree = ensureSyntaxTree(state, state.doc.length, 200)
  if (!tree) return spec

  const activeLines = new Set<number>()
  // Unfocused, the whole doc reads as rendered; raw markdown appears only where you are editing.
  for (const range of focused ? state.selection.ranges : []) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) activeLines.add(n)
  }
  const isActive = (pos: number): boolean => activeLines.has(state.doc.lineAt(pos).number)
  const hideWithSpace = (from: number, to: number): void => {
    const end = state.doc.sliceString(to, to + 1) === ' ' ? to + 1 : to
    spec.hidden.push({ from, to: end })
  }
  const styleLines = (from: number, to: number, className: string): void => {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos)
      spec.lines.push({ from: line.from, className })
      pos = line.to + 1
    }
  }

  const frontmatterEnd = frontmatterRange(state)
  if (frontmatterEnd !== null) {
    styleLines(0, frontmatterEnd, 'cm-md-frontmatter')
    for (const fence of [state.doc.line(1), state.doc.lineAt(frontmatterEnd)]) {
      if (!isActive(fence.from)) {
        spec.lines.push({ from: fence.from, className: 'cm-md-frontmatter-fence' })
        spec.hidden.push({ from: fence.from, to: fence.to })
      }
    }
  }

  tree.iterate({
    enter: (node) => {
      const { name, from, to } = node
      // The parser reads frontmatter as markdown (its closing --- turns the line above into a
      // setext heading), so leave that range to the frontmatter styling above.
      if (frontmatterEnd !== null && from <= frontmatterEnd) return to > frontmatterEnd
      const heading = /^ATXHeading(\d)$/.exec(name)
      if (heading) {
        spec.lines.push({ from: state.doc.lineAt(from).from, className: `cm-md-h${heading[1]}` })
        return
      }
      const inlineClass = INLINE_STYLE[name]
      if (inlineClass) spec.marks.push({ from, to, className: inlineClass })

      if (name === 'Blockquote') styleLines(from, to, 'cm-md-quote')
      else if (name === 'FencedCode') styleLines(from, to, 'cm-md-codeblock')
      else if (name === 'HorizontalRule' && !isActive(from)) {
        spec.lines.push({ from: state.doc.lineAt(from).from, className: 'cm-md-hr' })
        spec.hidden.push({ from, to })
      } else if (isActive(from)) {
        return
      } else if (name === 'HeaderMark' || name === 'QuoteMark') {
        hideWithSpace(from, to)
      } else if (name === 'CodeMark' && node.node.parent?.name === 'InlineCode') {
        spec.hidden.push({ from, to })
      } else if ((name === 'CodeMark' || name === 'CodeInfo') && node.node.parent?.name === 'FencedCode') {
        spec.lines.push({ from: state.doc.lineAt(from).from, className: 'cm-md-fence' })
        spec.hidden.push({ from, to })
      } else if (INLINE_MARKS.has(name)) {
        spec.hidden.push({ from, to })
      }
    }
  })
  return spec
}

/** End offset of a leading `---` YAML frontmatter block, or null when the doc has none. */
export function frontmatterRange(state: EditorState): number | null {
  if (state.doc.lines < 2 || state.doc.line(1).text !== '---') return null
  for (let n = 2; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    if (line.text === '---') return line.to
  }
  return null
}

class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super()
  }

  override eq(other: TableWidget): boolean {
    return other.source === this.source
  }

  override toDOM(view: EditorView): HTMLElement {
    const { header, rows } = parseTable(this.source)
    const wrapper = document.createElement('div')
    wrapper.className = 'cm-md-table'
    const table = wrapper.appendChild(document.createElement('table'))
    const headRow = table.appendChild(document.createElement('thead')).appendChild(document.createElement('tr'))
    for (const cell of header) fillCell(headRow.appendChild(document.createElement('th')), cell)
    const body = table.appendChild(document.createElement('tbody'))
    for (const row of rows) {
      const tr = body.appendChild(document.createElement('tr'))
      header.forEach((_, i) => fillCell(tr.appendChild(document.createElement('td')), row[i] ?? ''))
    }
    // Clicking a rendered table drops the cursor into its source, which switches it to raw.
    wrapper.addEventListener('mousedown', (event) => {
      event.preventDefault()
      view.dispatch({ selection: { anchor: view.posAtDOM(wrapper) } })
      view.focus()
    })
    return wrapper
  }

  override ignoreEvent(): boolean {
    return true
  }
}

function fillCell(cell: HTMLElement, source: string): void {
  for (const token of tokenizeInline(source)) {
    if (token.kind === 'text') {
      cell.append(token.text)
      continue
    }
    const tag = token.kind === 'code' ? 'code' : token.kind === 'strong' ? 'strong' : token.kind === 'em' ? 'em' : 'span'
    const element = cell.appendChild(document.createElement(tag))
    if (token.kind === 'link') element.className = 'cm-md-link'
    element.textContent = token.text
  }
}

function tableDecorations(state: EditorState): DecorationSet {
  const tree = ensureSyntaxTree(state, state.doc.length, 200)
  if (!tree) return Decoration.none
  const ranges: Range<Decoration>[] = []
  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Table') return
      const from = state.doc.lineAt(node.from).from
      const to = state.doc.lineAt(node.to).to
      const editing = state.selection.ranges.some((r) => r.from <= to && r.to >= from)
      if (!editing) {
        ranges.push(Decoration.replace({ widget: new TableWidget(state.doc.sliceString(from, to)), block: true }).range(from, to))
      }
      return false
    }
  })
  return Decoration.set(ranges)
}

/** Block widgets can't come from a view plugin, so rendered tables live in a state field. */
const tableField = StateField.define<DecorationSet>({
  create: tableDecorations,
  update: (decorations, tr) => (tr.docChanged || tr.selection ? tableDecorations(tr.state) : decorations),
  provide: (field) => EditorView.decorations.from(field)
})

function toDecorations(spec: PreviewSpec): { all: DecorationSet; hidden: DecorationSet } {
  const hidden: Range<Decoration>[] = spec.hidden
    .filter((r) => r.to > r.from)
    .map((r) => Decoration.replace({}).range(r.from, r.to))
  const all: Range<Decoration>[] = [
    ...hidden,
    ...spec.marks.filter((m) => m.to > m.from).map((m) => Decoration.mark({ class: m.className }).range(m.from, m.to)),
    ...spec.lines.map((l) => Decoration.line({ class: l.className }).range(l.from))
  ]
  return { all: Decoration.set(all, true), hidden: Decoration.set(hidden, true) }
}

class LivePreview {
  decorations: DecorationSet
  hidden: DecorationSet

  constructor(view: EditorView) {
    ;({ all: this.decorations, hidden: this.hidden } = toDecorations(computePreview(view.state, view.hasFocus)))
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      ;({ all: this.decorations, hidden: this.hidden } = toDecorations(computePreview(update.state, update.view.hasFocus)))
    }
  }
}

const livePreviewPlugin = ViewPlugin.fromClass(LivePreview, { decorations: (p) => p.decorations })

export const livePreview = [
  livePreviewPlugin,
  tableField,
  // Cursor movement steps over hidden marks instead of landing inside invisible text.
  EditorView.atomicRanges.of((view) => view.plugin(livePreviewPlugin)?.hidden ?? Decoration.none)
]
