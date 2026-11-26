export interface ParsedTable {
  header: string[]
  rows: string[][]
}

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'link'; text: string }

/** Splits a GFM table's source into header and body cells. Escaped pipes (`\|`) stay in cells. */
export function parseTable(source: string): ParsedTable {
  const lines = source.split('\n').filter((line) => line.trim().length > 0)
  const cells = (line: string): string[] => {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
    return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
  }
  const [headerLine = '', , ...bodyLines] = lines
  return { header: cells(headerLine), rows: bodyLines.map(cells) }
}

/** Tokenises the inline markdown that shows up in table cells: code, bold, italic, links. */
export function tokenizeInline(text: string): InlineToken[] {
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|\[([^\]]+)\]\([^)]*\)/g
  const tokens: InlineToken[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) tokens.push({ kind: 'text', text: text.slice(last, match.index) })
    const [, code, strong1, strong2, em1, em2, link] = match
    if (code !== undefined) tokens.push({ kind: 'code', text: code })
    else if (strong1 !== undefined || strong2 !== undefined) tokens.push({ kind: 'strong', text: strong1 ?? strong2 ?? '' })
    else if (em1 !== undefined || em2 !== undefined) tokens.push({ kind: 'em', text: em1 ?? em2 ?? '' })
    else if (link !== undefined) tokens.push({ kind: 'link', text: link })
    last = match.index + match[0].length
  }
  if (last < text.length) tokens.push({ kind: 'text', text: text.slice(last) })
  return tokens
}
