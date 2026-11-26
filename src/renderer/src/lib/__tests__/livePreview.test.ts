import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { computePreview, frontmatterRange } from '../livePreview'

const DOC = '# Title\n\nSome **bold** and `code` and [a link](https://x.y).\n\n> quoted\n'

function preview(cursor: number) {
  const state = EditorState.create({
    doc: DOC,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage })]
  })
  const spec = computePreview(state)
  const hidden = spec.hidden.map((r) => DOC.slice(r.from, r.to))
  return { spec, hidden }
}

describe('computePreview', () => {
  it('hides syntax marks on lines without the cursor', () => {
    const { hidden } = preview(DOC.length)
    expect(hidden).toEqual(expect.arrayContaining(['# ', '**', '`', '[', ']', '(', 'https://x.y', ')']))
  })

  it('shows raw markdown on the line with the cursor', () => {
    const { hidden } = preview(DOC.indexOf('bold'))
    expect(hidden).toContain('# ')
    expect(hidden).not.toContain('**')
    expect(hidden).not.toContain('`')
  })

  it('styles headings, emphasis, code, links and quotes regardless of cursor', () => {
    const { spec } = preview(DOC.indexOf('bold'))
    expect(spec.lines).toEqual(expect.arrayContaining([{ from: 0, className: 'cm-md-h1' }]))
    expect(spec.lines.some((l) => l.className === 'cm-md-quote')).toBe(true)
    const classes = spec.marks.map((m) => m.className)
    expect(classes).toEqual(expect.arrayContaining(['cm-md-strong', 'cm-md-code', 'cm-md-link']))
  })

  it('hides the quote mark off the cursor line', () => {
    const { hidden } = preview(0)
    expect(hidden).toContain('> ')
  })
})

describe('frontmatter', () => {
  const doc = '---\nstatus: draft\ndate: 2026-10-16\n---\n\n# Body\n'
  const state = (cursor: number) =>
    EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [markdown({ base: markdownLanguage })] })

  it('finds the closing fence', () => {
    expect(frontmatterRange(state(doc.length))).toBe(doc.indexOf('\n\n'))
  })

  it('styles frontmatter lines, hides fences off the cursor and does not treat it as a heading', () => {
    const spec = computePreview(state(doc.length))
    expect(spec.lines.filter((l) => l.className === 'cm-md-frontmatter')).toHaveLength(4)
    expect(spec.hidden.map((r) => doc.slice(r.from, r.to))).toEqual(expect.arrayContaining(['---']))
    expect(spec.lines.some((l) => l.className === 'cm-md-h2')).toBe(false)
  })
})

describe('fenced code', () => {
  it('hides fence marks and info off the cursor line', () => {
    const doc = 'Intro\n\n```ts\nconst x = 1\n```\n'
    const state = EditorState.create({ doc, selection: EditorSelection.cursor(0), extensions: [markdown({ base: markdownLanguage })] })
    const hidden = computePreview(state).hidden.map((r) => doc.slice(r.from, r.to))
    expect(hidden).toEqual(expect.arrayContaining(['```', 'ts']))
  })
})

describe('focus', () => {
  it('renders every line when the editor is not focused', () => {
    const doc = '# Title\n'
    const state = EditorState.create({ doc, selection: EditorSelection.cursor(2), extensions: [markdown({ base: markdownLanguage })] })
    expect(computePreview(state, false).hidden.map((r) => doc.slice(r.from, r.to))).toContain('# ')
    expect(computePreview(state, true).hidden.map((r) => doc.slice(r.from, r.to))).not.toContain('# ')
  })
})
