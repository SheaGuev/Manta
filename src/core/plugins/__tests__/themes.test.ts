import { describe, expect, it } from 'vitest'
import { convertTheme, parseEditorTheme, parseJsonc, searchThemes, themeVariants } from '../themes'

describe('parseJsonc', () => {
  it('drops comments and trailing commas but keeps slashes inside strings', () => {
    const source = `{
      // line comment
      "url": "https://example.com/a//b", /* block */
      "list": [1, 2,],
    }`
    expect(parseJsonc(source)).toEqual({ url: 'https://example.com/a//b', list: [1, 2] })
  })

  it('keeps escaped quotes inside strings', () => {
    expect(parseJsonc('{"a": "say \\"hi\\" // not a comment"}')).toEqual({ a: 'say "hi" // not a comment' })
  })
})

describe('convertTheme', () => {
  const theme = {
    type: 'dark',
    colors: { 'editor.background': '#282a36', 'editor.foreground': '#f8f8f2', 'editorCursor.foreground': '#f8f8f0', 'editorLineNumber.foreground': '#6272a4' },
    tokenColors: [
      { scope: 'comment', settings: { foreground: '#6272a4', fontStyle: 'italic' } },
      { scope: ['string', 'string.quoted'], settings: { foreground: '#f1fa8c' } },
      { scope: 'keyword, storage.type', settings: { foreground: '#ff79c6' } },
      { scope: 'keyword.control', settings: { foreground: '#ff00ff', fontStyle: '' } },
      { scope: 'entity.name.function', settings: { foreground: '#50fa7b' } },
      { scope: 'meta.class entity.name.type', settings: { foreground: '#8be9fd' } },
      { settings: { foreground: '#ffffff' } }
    ]
  }

  it('turns the editor colours into surface variables', () => {
    const { vars } = convertTheme({ name: 'Dracula', json: theme, dark: true })
    expect(vars).toMatchObject({ '--code-bg': '#282a36', '--code-fg': '#f8f8f2', '--code-cursor': '#f8f8f0', '--code-gutter': '#6272a4' })
  })

  it('colours each token kind by its most specific matching scope', () => {
    const { vars } = convertTheme({ name: 'Dracula', json: theme, dark: true })
    expect(vars['--code-comment']).toBe('#6272a4')
    expect(vars['--code-comment-style']).toBe('italic')
    expect(vars['--code-string']).toBe('#f1fa8c')
    expect(vars['--code-keyword']).toBe('#ff00ff')
    expect(vars['--code-keyword-style']).toBe('normal')
    expect(vars['--code-function']).toBe('#50fa7b')
    expect(vars['--code-type']).toBe('#8be9fd')
  })

  it('leaves a token kind the theme says nothing about to Manta\'s colour', () => {
    expect(convertTheme({ name: 'x', json: theme, dark: true }).vars['--code-tag']).toBeUndefined()
  })

  it('reads light or dark from the theme, else from the extension', () => {
    expect(convertTheme({ name: 'x', json: { type: 'light' }, dark: true }).dark).toBe(false)
    expect(convertTheme({ name: 'x', json: {}, dark: false }).dark).toBe(false)
  })

  it('copes with a theme that has nothing usable', () => {
    expect(convertTheme({ name: 'empty', json: 'garbage', dark: true })).toEqual({ name: 'empty', dark: true, vars: {} })
  })
})

describe('parseEditorTheme', () => {
  it('keeps only --code-* variables with plain values', () => {
    const theme = parseEditorTheme({ name: 'T', dark: true, vars: { '--code-bg': '#000', '--bg': '#fff', '--code-fg': 'red; } body { display: none', '--code-string': 3 } })
    expect(theme).toEqual({ name: 'T', dark: true, vars: { '--code-bg': '#000' } })
  })

  it('is null for something that is not a theme', () => {
    expect(parseEditorTheme(null)).toBeNull()
    expect(parseEditorTheme({ name: 'x' })).toBeNull()
  })
})

/** Real Open VSX; only with MANTA_NETWORK_TESTS=1. */
describe.runIf(process.env.MANTA_NETWORK_TESTS === '1')('Open VSX', () => {
  it('finds Dracula and converts its theme', async () => {
    const found = await searchThemes({ query: 'dracula' })
    expect(found.some((t) => t.id === 'dracula-theme.theme-dracula')).toBe(true)
    const [variant] = await themeVariants({ id: 'dracula-theme.theme-dracula' })
    expect(variant?.vars['--code-bg']?.toLowerCase()).toBe('#282a36')
    expect(variant?.vars['--code-keyword']).toBeTruthy()
  }, 60_000)
})
