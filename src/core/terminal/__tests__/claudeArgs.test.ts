import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeArgsStore, parseClaudeArgs, permissionSummary, splitArgs } from '../claudeArgs'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function settingsFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'manta-claude-args-'))
  dirs.push(dir)
  return path.join(dir, 'nested', 'terminal-settings.json')
}

describe('splitArgs', () => {
  it('splits on whitespace', () => {
    expect(splitArgs('  --dangerously-skip-permissions   --model opus ')).toEqual(['--dangerously-skip-permissions', '--model', 'opus'])
  })

  it('keeps quoted words whole, and empty quotes as an empty word', () => {
    expect(splitArgs(`--append-system-prompt "be brief, please" --name 'it''s' ""`)).toEqual(['--append-system-prompt', 'be brief, please', '--name', 'its', ''])
  })

  it('handles backslash escapes outside and inside double quotes, not inside single quotes', () => {
    expect(splitArgs(String.raw`a\ b "c\"d" 'e\f'`)).toEqual(['a b', 'c"d', String.raw`e\f`])
  })

  it('is empty for blank text', () => {
    expect(splitArgs('   ')).toEqual([])
  })

  it('returns null when a quote is left open', () => {
    expect(splitArgs('--name "open')).toBeNull()
    expect(splitArgs("--name 'open")).toBeNull()
  })
})

describe('parseClaudeArgs', () => {
  it('passes ordinary flags through', () => {
    expect(parseClaudeArgs('--dangerously-skip-permissions')).toEqual({ ok: true, args: ['--dangerously-skip-permissions'] })
  })

  it('refuses the flags Manta sets itself, with or without =', () => {
    for (const text of ['--settings x.json', '--session-id=abc', '--resume', '-r abc', '--continue', '-c']) {
      expect(parseClaudeArgs(text)).toMatchObject({ ok: false, message: expect.stringContaining('itself') })
    }
  })

  it('does not mistake a longer flag for a reserved one', () => {
    expect(parseClaudeArgs('--settings-extra --continue-on-error')).toMatchObject({ ok: true })
  })

  it('refuses an open quote', () => {
    expect(parseClaudeArgs('"oops')).toEqual({ ok: false, message: 'A quote is left open' })
  })
})

describe('permissionSummary', () => {
  it('says what sessions may do from the permission flags', () => {
    expect(permissionSummary([])).toEqual(['Asks before edits and commands'])
    expect(permissionSummary(['--permission-mode', 'acceptEdits', '--model', 'opus'])).toEqual(['Edits files without asking'])
    expect(permissionSummary(['--permission-mode=plan'])).toEqual(['Plan mode: no edits'])
    expect(permissionSummary(['--dangerously-skip-permissions'])).toEqual(['Never asks permission'])
    expect(permissionSummary(['--allowedTools', 'Bash(npm test)', 'Read,Edit', '--disallowed-tools=WebFetch'])).toEqual(['Asks before edits and commands', 'Allowed: Bash(npm test), Read, Edit', 'Denied: WebFetch'])
  })
})

describe('ClaudeArgsStore', () => {
  it('starts empty, and saves trimmed text that a new store reads back', async () => {
    const file = await settingsFile()
    const store = await ClaudeArgsStore.open(file)
    expect(store.get()).toBe('')
    expect(store.args()).toEqual([])
    expect(await store.set('  --dangerously-skip-permissions --model "opus 5" ')).toMatchObject({ ok: true })
    const reopened = await ClaudeArgsStore.open(file)
    expect(reopened.get()).toBe('--dangerously-skip-permissions --model "opus 5"')
    expect(reopened.args()).toEqual(['--dangerously-skip-permissions', '--model', 'opus 5'])
  })

  it('keeps the previous arguments when the new ones are refused, and writes nothing', async () => {
    const file = await settingsFile()
    const store = await ClaudeArgsStore.open(file)
    await store.set('--verbose')
    expect(await store.set('--resume abc')).toMatchObject({ ok: false })
    expect(store.get()).toBe('--verbose')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ claudeArgs: '--verbose' })
  })

  it('reads an unreadable file, or saved text that no longer parses, as no arguments', async () => {
    const file = await settingsFile()
    await (await ClaudeArgsStore.open(file)).set('--verbose')
    await writeFile(file, '{ not json')
    expect((await ClaudeArgsStore.open(file)).get()).toBe('')
    await writeFile(file, JSON.stringify({ claudeArgs: '--settings mine.json' }))
    expect((await ClaudeArgsStore.open(file)).args()).toEqual([])
  })
})
