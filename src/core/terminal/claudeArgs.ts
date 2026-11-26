import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { OpResult } from '../../shared/ipc'

/** Flags Manta passes itself; a second copy would break its hooks or its session tracking. */
const RESERVED = ['--settings', '--session-id', '--resume', '-r', '--continue', '-c']

/** Splits text into words the way a POSIX shell does: single and double quotes, backslash escapes. Null when a quote is left open. */
export function splitArgs(text: string): string[] | null {
  const words: string[] = []
  let word: string | null = null
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i)
    if (quote === "'") {
      if (char === "'") quote = null
      else word += char
    } else if (quote === '"') {
      if (char === '"') quote = null
      else if (char === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) word += text.charAt(++i)
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      word ??= ''
    } else if (char === '\\' && i + 1 < text.length) {
      word = (word ?? '') + text.charAt(++i)
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word)
      word = null
    } else {
      word = (word ?? '') + char
    }
  }
  if (quote) return null
  if (word !== null) words.push(word)
  return words
}

/** The extra arguments as `claude` gets them, or the refusal to show when Manta can't use them. */
export function parseClaudeArgs(text: string): { ok: true; args: string[] } | { ok: false; message: string } {
  const args = splitArgs(text)
  if (!args) return { ok: false, message: 'A quote is left open' }
  const reserved = args.find((arg) => RESERVED.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))
  if (reserved) return { ok: false, message: `Manta sets ${reserved.split('=')[0]} itself, so it can track the session` }
  return { ok: true, args }
}

/** Every value given to the flags, as `--flag value…` or `--flag=value`. */
function flagValues(args: readonly string[], flags: readonly string[]): string[] {
  return args.flatMap((arg, i) => {
    const flag = flags.find((f) => arg === f || arg.startsWith(`${f}=`))
    if (!flag) return []
    if (arg.startsWith(`${flag}=`)) return [arg.slice(flag.length + 1)]
    const values: string[] = []
    for (const next of args.slice(i + 1)) {
      if (next.startsWith('-')) break
      values.push(next)
    }
    return values
  })
}

/** Tool rules separated by commas or spaces, keeping a rule's own spaces inside its parentheses (`Bash(npm test)`). */
function toolRules(values: readonly string[]): string[] {
  return values.flatMap((value) => value.match(/[^\s,(]+(?:\([^)]*\))?/g) ?? [])
}

/** What sessions may do without asking, in a few words each, from the extra arguments. */
export function permissionSummary(args: readonly string[]): string[] {
  const mode = flagValues(args, ['--permission-mode'])[0]
  const bypass = args.includes('--dangerously-skip-permissions') || mode === 'bypassPermissions'
  const summary = bypass ? ['Never asks permission'] : mode === 'acceptEdits' ? ['Edits files without asking'] : mode === 'plan' ? ['Plan mode: no edits'] : ['Asks before edits and commands']
  const allowed = toolRules(flagValues(args, ['--allowedTools', '--allowed-tools']))
  const denied = toolRules(flagValues(args, ['--disallowedTools', '--disallowed-tools']))
  return [...summary, ...(allowed.length > 0 ? [`Allowed: ${allowed.join(', ')}`] : []), ...(denied.length > 0 ? [`Denied: ${denied.join(', ')}`] : [])]
}

/** The extra arguments every Claude session starts with, as the user typed them, in `<userData>/terminal-settings.json`. */
export class ClaudeArgsStore {
  private constructor(
    private readonly file: string,
    private text: string
  ) {}

  /** An unreadable file, or saved text that no longer parses, reads as no extra arguments. */
  static async open(file: string): Promise<ClaudeArgsStore> {
    let text = ''
    try {
      const raw: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (typeof raw === 'object' && raw !== null && 'claudeArgs' in raw && typeof raw.claudeArgs === 'string') text = raw.claudeArgs
    } catch {
      /** No file yet. */
    }
    return new ClaudeArgsStore(file, parseClaudeArgs(text).ok ? text : '')
  }

  get(): string {
    return this.text
  }

  args(): string[] {
    const parsed = parseClaudeArgs(this.text)
    return parsed.ok ? parsed.args : []
  }

  async set(text: string): Promise<OpResult> {
    const trimmed = text.trim()
    const parsed = parseClaudeArgs(trimmed)
    if (!parsed.ok) return parsed
    await mkdir(path.dirname(this.file), { recursive: true })
    await writeFile(`${this.file}.tmp`, `${JSON.stringify({ claudeArgs: trimmed }, null, 2)}\n`)
    await rename(`${this.file}.tmp`, this.file)
    this.text = trimmed
    return { ok: true, message: trimmed ? `New Claude sessions start with ${trimmed}` : 'New Claude sessions start with no extra arguments' }
  }
}
