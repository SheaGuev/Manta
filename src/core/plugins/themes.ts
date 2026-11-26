import { isAppThemeId, type EditorTheme, type ThemeEntry } from '../../shared/ipc'
import { readZip } from './zip'

const OPEN_VSX = 'https://open-vsx.org/api'
const SEARCH_SIZE = 24

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** JSON with comments and trailing commas, as VS Code themes are written. Strings are left alone. */
export function parseJsonc(source: string): unknown {
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === '"') {
      const start = i
      for (i++; i < source.length && source[i] !== '"'; i++) if (source[i] === '\\') i++
      out += source.slice(start, i + 1)
    } else if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2)
      if (i < 0) break
      i++
    } else out += char
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/**
 * Manta's code-token kinds, each with the TextMate scopes a theme colours it by, most telling first.
 * They become `--code-<kind>` variables that `codeHighlight` reads.
 */
const TOKEN_SCOPES: Record<string, string[]> = {
  keyword: ['keyword.control', 'keyword', 'storage.type', 'storage.modifier', 'storage'],
  string: ['string.quoted', 'string'],
  number: ['constant.numeric', 'constant.language', 'constant'],
  comment: ['comment.line', 'comment'],
  function: ['entity.name.function', 'support.function', 'meta.function-call'],
  type: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.name'],
  property: ['variable.other.property', 'support.type.property-name', 'meta.object-literal.key', 'variable.other.object.property'],
  tag: ['entity.name.tag'],
  variable: ['variable.other.constant', 'variable.other', 'variable'],
  link: ['markup.underline.link', 'string.other.link'],
  invalid: ['invalid.illegal', 'invalid']
}

/** The editor surface: a `--code-<name>` variable for each, from the theme's workbench colours. */
const SURFACE_COLORS: Record<string, string[]> = {
  bg: ['editor.background'],
  fg: ['editor.foreground', 'foreground'],
  selection: ['editor.selectionBackground'],
  'line-highlight': ['editor.lineHighlightBackground'],
  gutter: ['editorLineNumber.foreground'],
  'gutter-active': ['editorLineNumber.activeForeground'],
  cursor: ['editorCursor.foreground']
}

interface TokenRule {
  selectors: string[]
  foreground: string | null
  fontStyle: string | null
}

function tokenRules(tokenColors: unknown): TokenRule[] {
  if (!Array.isArray(tokenColors)) return []
  return tokenColors.filter(isRecord).flatMap((rule) => {
    const settings = isRecord(rule.settings) ? rule.settings : null
    if (!settings) return []
    const scope = rule.scope
    const selectors = (typeof scope === 'string' ? scope.split(',') : Array.isArray(scope) ? scope.filter((s): s is string => typeof s === 'string') : []).map((s) => s.trim()).filter(Boolean)
    const foreground = typeof settings.foreground === 'string' ? settings.foreground : null
    const fontStyle = typeof settings.fontStyle === 'string' ? settings.fontStyle : null
    return selectors.length > 0 && (foreground || fontStyle) ? [{ selectors, foreground, fontStyle }] : []
  })
}

/**
 * How well a TextMate selector matches a scope: the number of segments matched (`string` matches
 * `string.quoted` with 1), 0 for no match. Descendant selectors (`meta.x string`) match on their last part.
 */
function selectorScore(selector: string, scope: string): number {
  const last = selector.split(/\s+/).pop() ?? ''
  if (scope !== last && !scope.startsWith(`${last}.`)) return 0
  return last.split('.').length
}

/** The rule colouring a scope: the most specific selector wins, then the later rule, as in VS Code. */
function ruleFor(rules: TokenRule[], scope: string, field: 'foreground' | 'fontStyle'): string | null {
  let best: { score: number; value: string } | null = null
  for (const rule of rules) {
    const value = rule[field]
    if (value === null) continue
    for (const selector of rule.selectors) {
      const score = selectorScore(selector, scope)
      if (score > 0 && (!best || score >= best.score)) best = { score, value }
    }
  }
  return best?.value ?? null
}

/** A VS Code colour theme as Manta's code editor variables. */
export function convertTheme({ name, json, dark }: { name: string; json: unknown; dark: boolean }): EditorTheme {
  const theme = isRecord(json) ? json : {}
  const colors = isRecord(theme.colors) ? theme.colors : {}
  const rules = tokenRules(theme.tokenColors)
  const vars: Record<string, string> = {}
  for (const [variable, keys] of Object.entries(SURFACE_COLORS)) {
    const value = keys.map((key) => colors[key]).find((v): v is string => typeof v === 'string')
    if (value) vars[`--code-${variable}`] = value
  }
  for (const [kind, scopes] of Object.entries(TOKEN_SCOPES)) {
    const color = scopes.map((scope) => ruleFor(rules, scope, 'foreground')).find((v) => v !== null)
    if (color) vars[`--code-${kind}`] = color
    const style = scopes.map((scope) => ruleFor(rules, scope, 'fontStyle')).find((v) => v !== null)
    if (style !== undefined) vars[`--code-${kind}-style`] = style.includes('italic') ? 'italic' : 'normal'
  }
  return { name, dark: typeof theme.type === 'string' ? theme.type !== 'light' : dark, vars }
}

/**
 * A stored or sent theme; null for anything else. Only `--code-*` variables, so a downloaded theme can't
 * restyle the app; `app` may only name one of Manta's built-in themes, whose colours are Manta's own CSS.
 */
export function parseEditorTheme(value: unknown): EditorTheme | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !isRecord(value.vars)) return null
  const vars = Object.fromEntries(Object.entries(value.vars).filter((e): e is [string, string] => e[0].startsWith('--code-') && typeof e[1] === 'string' && !/[;{}<>]/.test(e[1])))
  const theme: EditorTheme = { name: value.name, dark: value.dark !== false, vars }
  return isAppThemeId(value.app) ? { ...theme, app: value.app } : theme
}

/** Open VSX's colour themes matching `query`, most downloaded first. */
export async function searchThemes({ query, fetchImpl = fetch }: { query: string; fetchImpl?: typeof fetch }): Promise<ThemeEntry[]> {
  const url = `${OPEN_VSX}/-/search?category=Themes&sortBy=downloadCount&sortOrder=desc&size=${SEARCH_SIZE}&query=${encodeURIComponent(query)}`
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`Open VSX search failed: ${response.status}`)
  const body: unknown = await response.json()
  const extensions = isRecord(body) && Array.isArray(body.extensions) ? body.extensions.filter(isRecord) : []
  return extensions.map((e) => ({
    id: `${text(e.namespace)}.${text(e.name)}`,
    name: text(e.displayName) || text(e.name),
    description: text(e.description),
    publisher: text(e.namespace),
    downloads: typeof e.downloadCount === 'number' ? e.downloadCount : 0,
    icon: isRecord(e.files) ? text(e.files.icon) || null : null
  }))
}

/** A theme file from the extension, following `include` (a theme built on another) up to a few levels. */
function readThemeFile({ files, file, depth = 0 }: { files: Map<string, Buffer>; file: string; depth?: number }): Record<string, unknown> {
  const data = files.get(file)
  if (!data) throw new Error(`The extension has no ${file}`)
  const json = parseJsonc(data.toString('utf8'))
  const theme = isRecord(json) ? json : {}
  if (typeof theme.include !== 'string' || depth > 3) return theme
  const base = readThemeFile({ files, file: new URL(theme.include, `file:///${file}`).pathname.slice(1), depth: depth + 1 })
  return {
    ...base,
    ...theme,
    colors: { ...(isRecord(base.colors) ? base.colors : {}), ...(isRecord(theme.colors) ? theme.colors : {}) },
    tokenColors: [...(Array.isArray(base.tokenColors) ? base.tokenColors : []), ...(Array.isArray(theme.tokenColors) ? theme.tokenColors : [])]
  }
}

/** Downloads an Open VSX extension and converts each colour theme it contributes. */
export async function themeVariants({ id, fetchImpl = fetch }: { id: string; fetchImpl?: typeof fetch }): Promise<EditorTheme[]> {
  const [namespace, name] = id.split('.', 2)
  if (!namespace || !name) throw new Error(`Not an Open VSX extension id: ${id}`)
  const meta = await fetchImpl(`${OPEN_VSX}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`)
  if (!meta.ok) throw new Error(`Open VSX has no ${id}: ${meta.status}`)
  const body: unknown = await meta.json()
  const download = isRecord(body) && isRecord(body.files) ? text(body.files.download) : ''
  if (!download.startsWith('https://')) throw new Error(`${id} has no download`)
  const vsix = await fetchImpl(download)
  if (!vsix.ok) throw new Error(`Downloading ${id} failed: ${vsix.status}`)
  const files = readZip(Buffer.from(await vsix.arrayBuffer()))
  const pkgFile = files.get('extension/package.json')
  const pkg: unknown = pkgFile ? JSON.parse(pkgFile.toString('utf8')) : null
  const contributes = isRecord(pkg) && isRecord(pkg.contributes) ? pkg.contributes : {}
  const themes = Array.isArray(contributes.themes) ? contributes.themes.filter(isRecord) : []
  if (themes.length === 0) throw new Error(`${id} contributes no colour themes`)
  return themes.map((theme) => {
    const file = `extension/${text(theme.path).replace(/^\.\//, '')}`
    const label = text(theme.label) || text(theme.id) || id
    return convertTheme({ name: label, json: readThemeFile({ files, file }), dark: text(theme.uiTheme) !== 'vs' })
  })
}
