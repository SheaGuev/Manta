import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Workspace } from '../workspace'

const dirs: string[] = []
const workspaces: Workspace[] = []

afterEach(async () => {
  for (const ws of workspaces.splice(0)) ws.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  })
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'manta-'))
  dirs.push(dir)
  return dir
}

/** A bare "origin", plus two clones: `app` (opened in Manta) and `other` (a teammate pushing). */
async function setup(files: Record<string, string>): Promise<{ app: string; other: string }> {
  const origin = await tempDir()
  git(origin, 'init', '--bare', '-b', 'main')
  const seed = await tempDir()
  git(seed, 'init', '-b', 'main')
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(seed, name), text)
  git(seed, 'add', '-A')
  git(seed, 'commit', '-m', 'seed')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-u', 'origin', 'main')
  const app = await tempDir()
  const other = await tempDir()
  git(app, 'clone', origin, '.')
  git(other, 'clone', origin, '.')
  for (const dir of [app, other]) {
    git(dir, 'config', 'user.name', 't')
    git(dir, 'config', 'user.email', 't@t')
  }
  return { app, other }
}

/** An editor replica wired to the workspace the way the renderer is. */
async function openReplica(ws: Workspace, relPath: string): Promise<{ doc: Y.Doc; text: Y.Text }> {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await ws.openDoc(relPath), 'main')
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'main') ws.applyEditorUpdate(relPath, update)
  })
  return { doc, text: doc.getText('md') }
}

async function openWorkspace(dir: string, replicas: Map<string, Y.Doc> = new Map()): Promise<Workspace> {
  const ws = await Workspace.open(dir, (relPath, update) => {
    const replica = replicas.get(relPath)
    if (replica) Y.applyUpdate(replica, update, 'main')
  })
  workspaces.push(ws)
  return ws
}

function anchorTo(text: Y.Text, needle: string): () => string {
  const start = text.toString().indexOf(needle)
  const from = Y.createRelativePositionFromTypeIndex(text, start)
  const to = Y.createRelativePositionFromTypeIndex(text, start + needle.length - 1)
  return () => {
    const doc = text.doc
    if (!doc) throw new Error('detached text')
    const a = Y.createAbsolutePositionFromRelativePosition(from, doc)
    const b = Y.createAbsolutePositionFromRelativePosition(to, doc)
    return text.toString().slice(a?.index, (b?.index ?? 0) + 1)
  }
}

const BASE = '# Auth\n\nWe use magic links for login.\n\nSessions last 30 days.\n'

describe('Workspace', () => {
  it('saves a doc at once with saveNow, instead of after typing pauses', async () => {
    const { app } = await setup({ 'auth.md': BASE })
    const ws = await openWorkspace(app)
    const { text } = await openReplica(ws, 'auth.md')
    text.insert(0, 'Saved now. ')
    await ws.saveNow('auth.md')
    expect(await readFile(path.join(app, 'auth.md'), 'utf8')).toBe(`Saved now. ${BASE}`)
  })

  it('applies a formatter\'s output as minimal edits, keeping anchors on text it left alone, and saves', async () => {
    const { app } = await setup({ 'a.ts': 'const a = {b:1};\nexport const keep = "anchor here"\n' })
    const replicas = new Map<string, Y.Doc>()
    const ws = await openWorkspace(app, replicas)
    const { doc, text } = await openReplica(ws, 'a.ts')
    replicas.set('a.ts', doc)
    const anchor = anchorTo(text, 'anchor here')
    const before = (await ws.docText('a.ts')) ?? ''
    const after = 'const a = { b: 1 }\nexport const keep = "anchor here"\n'
    expect(await ws.applyFormatted('a.ts', { before, after })).toBe('applied')
    expect(text.toString()).toBe(after)
    expect(anchor()).toBe('anchor here')
    expect(await readFile(path.join(app, 'a.ts'), 'utf8')).toBe(after)
  })

  it('applies nothing when the text changed while the formatter ran', async () => {
    const { app } = await setup({ 'a.ts': 'const a = 1\n' })
    const ws = await openWorkspace(app)
    const { text } = await openReplica(ws, 'a.ts')
    const before = (await ws.docText('a.ts')) ?? ''
    text.insert(0, '// typed meanwhile\n')
    expect(await ws.applyFormatted('a.ts', { before, after: 'const a = 2\n' })).toBe('changed')
    expect((await ws.docText('a.ts')) ?? '').toBe('// typed meanwhile\nconst a = 1\n')
  })

  it('still saves when the file was already formatted', async () => {
    const { app } = await setup({ 'a.ts': 'const a = 1\n' })
    const ws = await openWorkspace(app)
    const { text } = await openReplica(ws, 'a.ts')
    text.insert(text.length, 'export {}\n')
    const before = (await ws.docText('a.ts')) ?? ''
    expect(await ws.applyFormatted('a.ts', { before, after: before })).toBe('unchanged')
    expect(await readFile(path.join(app, 'a.ts'), 'utf8')).toBe('const a = 1\nexport {}\n')
  })

  it('reads the text of open docs only', async () => {
    const { app } = await setup({ 'a.ts': 'x\n' })
    const ws = await openWorkspace(app)
    expect(await ws.docText('a.ts')).toBeNull()
    await openReplica(ws, 'a.ts')
    expect(await ws.docText('a.ts')).toBe('x\n')
  })

  it('finds the main checkout of a worktree, and the repo itself otherwise', async () => {
    const { app } = await setup({ 'a.ts': '' })
    const worktree = path.join(await tempDir(), 'wt')
    git(app, 'worktree', 'add', '-q', '-b', 'side', worktree)
    expect(await (await openWorkspace(worktree)).mainCheckout()).toBe(await realpath(app))
    expect(await (await openWorkspace(app)).mainCheckout()).toBe(await realpath(app))
  })

  it('does nothing in saveNow for a doc that isn\'t open', async () => {
    const { app } = await setup({ 'auth.md': BASE })
    const ws = await openWorkspace(app)
    await ws.saveNow('auth.md')
    expect(await readFile(path.join(app, 'auth.md'), 'utf8')).toBe(BASE)
  })

  it('seeds a new doc from HEAD and replays uncommitted working-tree edits', async () => {
    const { app } = await setup({ 'auth.md': BASE })
    await writeFile(path.join(app, 'auth.md'), `${BASE}Uncommitted line.\n`)
    const ws = await openWorkspace(app)
    const { text } = await openReplica(ws, 'auth.md')
    expect(text.toString()).toBe(`${BASE}Uncommitted line.\n`)
  })

  it('writes editor edits to disk', async () => {
    const { app } = await setup({ 'auth.md': BASE })
    const ws = await openWorkspace(app)
    const { text } = await openReplica(ws, 'auth.md')
    text.insert(text.toString().indexOf('magic'), 'passwordless ')
    await ws.idle()
    expect(await readFile(path.join(app, 'auth.md'), 'utf8')).toContain('passwordless magic links')
  })

  it('absorbs an outside edit while keeping in-app edits and anchors', async () => {
    const { app } = await setup({ 'auth.md': BASE })
    const replicas = new Map<string, Y.Doc>()
    const ws = await openWorkspace(app, replicas)
    const { doc, text } = await openReplica(ws, 'auth.md')
    replicas.set('auth.md', doc)
    const thread = anchorTo(text, 'Sessions last 30 days')
    await ws.idle()

    await writeFile(path.join(app, 'auth.md'), BASE.replace('Sessions last 30 days.', 'Sessions last 30 days, then refresh.'))
    text.insert(text.toString().indexOf('magic'), 'passwordless ')
    await ws.fileChanged('auth.md')
    await ws.idle()

    expect(text.toString()).toBe('# Auth\n\nWe use passwordless magic links for login.\n\nSessions last 30 days, then refresh.\n')
    expect(thread()).toBe('Sessions last 30 days')
    expect(await readFile(path.join(app, 'auth.md'), 'utf8')).toBe(text.toString())
  })

  it('commits an outside edit the watcher has not delivered yet, with a matching sync point', async () => {
    const { app } = await setup({ 'auth.md': BASE })
    const replicas = new Map<string, Y.Doc>()
    const ws = await openWorkspace(app, replicas)
    const { doc, text } = await openReplica(ws, 'auth.md')
    replicas.set('auth.md', doc)
    await writeFile(path.join(app, 'auth.md'), `${BASE}Edited in Obsidian.\n`)

    expect((await ws.commit('docs: update auth')).ok).toBe(true)

    expect(git(app, 'show', 'HEAD:auth.md')).toBe(`${BASE}Edited in Obsidian.\n`)
    expect(git(app, 'status', '--porcelain')).toBe('')
    await ws.idle()
    expect(text.toString()).toBe(`${BASE}Edited in Obsidian.\n`)
  })

  it('pulls an upstream change onto unpushed in-app edits without losing anchors', async () => {
    const { app, other } = await setup({ 'auth.md': BASE, 'untouched.md': '# Other\n' })
    const replicas = new Map<string, Y.Doc>()
    const ws = await openWorkspace(app, replicas)
    const { doc, text } = await openReplica(ws, 'auth.md')
    replicas.set('auth.md', doc)
    const thread = anchorTo(text, 'Sessions last 30 days')
    text.insert(text.toString().indexOf('magic'), 'passwordless ')
    await ws.idle()

    const pushed = '# Authentication\n\n> Owner: platform team\n\nWe use magic links for login.\n\nSessions last 30 days, then refresh.\n'
    await writeFile(path.join(other, 'auth.md'), pushed)
    git(other, 'commit', '-am', 'teammate edit')
    git(other, 'push')

    const result = await ws.pull()
    await ws.idle()

    expect(result).toMatchObject({ ok: true })
    const merged = '# Authentication\n\n> Owner: platform team\n\nWe use passwordless magic links for login.\n\nSessions last 30 days, then refresh.\n'
    expect(text.toString()).toBe(merged)
    expect(thread()).toBe('Sessions last 30 days')
    expect(git(app, 'rev-parse', 'HEAD')).toBe(git(app, 'rev-parse', 'origin/main'))
    expect(await readFile(path.join(app, 'auth.md'), 'utf8')).toBe(merged)
    expect(git(app, 'diff', '--', 'auth.md')).toContain('+We use passwordless magic links for login.')
  })

  it('restores CRDT state on reopen and absorbs edits made while closed', async () => {
    const { app } = await setup({ 'auth.md': BASE })
    const first = await openWorkspace(app)
    const replica = await openReplica(first, 'auth.md')
    replica.text.insert(0, 'Draft: ')
    await first.idle()
    first.close()

    await writeFile(path.join(app, 'auth.md'), `${await readFile(path.join(app, 'auth.md'), 'utf8')}Added while closed.\n`)
    const second = await openWorkspace(app)
    const { text } = await openReplica(second, 'auth.md')
    expect(text.toString()).toBe(`Draft: ${BASE}Added while closed.\n`)
  })

  it('creates a doc inside the repo and refuses paths outside it', async () => {
    const { app } = await setup({ 'auth.md': BASE })
    const ws = await openWorkspace(app)

    const created = await ws.createDoc('notes/ideas')

    expect(created.relPath).toBe('notes/ideas.md')
    expect(await readFile(path.join(app, 'notes/ideas.md'), 'utf8')).toBe('# ideas\n')
    expect(await ws.listFiles()).toContain('notes/ideas.md')
    expect(() => ws.createDoc('../escape')).toThrow('inside the repo')
    await expect(ws.createDoc('auth')).rejects.toThrow('already exists')
  })

  it('creates files and folders inside the repo only', async () => {
    const { app } = await setup({ 'auth.md': BASE })
    const ws = await openWorkspace(app)

    await ws.createFolder('src/empty')
    await ws.createFile('src/index.ts')

    expect(await readFile(path.join(app, 'src/index.ts'), 'utf8')).toBe('')
    expect((await stat(path.join(app, 'src/empty'))).isDirectory()).toBe(true)
    expect(await ws.listFiles('all')).toContain('src/index.ts')
    await expect(ws.createFile('src/index.ts')).rejects.toThrow('already exists')
    await expect(ws.createFolder('src')).rejects.toThrow('already exists')
    expect(() => ws.createFile('../escape.ts')).toThrow('inside the repo')
    expect(() => ws.createFolder('.git/hooks')).toThrow('inside the repo')
  })

  it('deletes a file or folder once confirmed, and an open doc with an unsaved edit stays deleted', async () => {
    const { app } = await setup({ 'auth.md': BASE })
    await mkdir(path.join(app, 'notes'))
    await writeFile(path.join(app, 'notes/a.md'), 'a\n')
    await writeFile(path.join(app, 'notes/b.md'), 'b\n')
    const ws = await openWorkspace(app)

    expect(await ws.deletePath('auth.md', async () => false)).toBeNull()
    expect(await readFile(path.join(app, 'auth.md'), 'utf8')).toBe(BASE)

    const { text } = await openReplica(ws, 'auth.md')
    text.insert(text.length, 'Unsaved.\n')
    const asked: unknown[] = []
    const confirm = async (summary: unknown): Promise<boolean> => {
      asked.push(summary)
      return true
    }
    expect(await ws.deletePath('auth.md', confirm)).toMatchObject({ ok: true })
    expect(await ws.deletePath('notes', confirm)).toMatchObject({ ok: true })
    // Past the write debounce: the edit made before deleting must not recreate the file.
    await new Promise((resolve) => setTimeout(resolve, 400))
    await ws.idle()

    expect(asked).toEqual([
      { relPath: 'auth.md', folder: false, files: 1, docsWithThreads: [] },
      { relPath: 'notes', folder: true, files: 2, docsWithThreads: [] }
    ])
    await expect(stat(path.join(app, 'auth.md'))).rejects.toThrow()
    await expect(stat(path.join(app, 'notes'))).rejects.toThrow()
    expect(await ws.deletePath('auth.md', confirm)).toMatchObject({ ok: false, message: 'auth.md no longer exists' })
    await expect(ws.deletePath('../escape.md', confirm)).rejects.toThrow('inside the repo')
    await expect(ws.deletePath('.git', confirm)).rejects.toThrow('inside the repo')
  })

  it('searches tracked and untracked file contents, skipping ignored files', async () => {
    const { app } = await setup({ 'auth.md': BASE, '.gitignore': 'build/\n' })
    await writeFile(path.join(app, 'notes.txt'), 'Nothing here\nMagic LINKS expire\n')
    await mkdir(path.join(app, 'build'))
    await writeFile(path.join(app, 'build/out.txt'), 'magic links\n')
    await writeFile(path.join(app, 'bundle.js'), `${'x'.repeat(500)}magic links${'y'.repeat(500)}\n`)
    const ws = await openWorkspace(app)

    const matches = await ws.searchContent('magic links')

    expect(matches.map((m) => [m.path, m.line])).toEqual([
      ['auth.md', 3],
      ['bundle.js', 1],
      ['notes.txt', 2]
    ])
    expect(matches[2]?.text).toBe('Magic LINKS expire')
    const long = matches[1]?.text ?? ''
    expect(long).toContain('magic links')
    expect(long.length).toBeLessThan(250)
    expect(await ws.searchContent('not in any file')).toEqual([])
  })

  it('refuses to pull diverged history', async () => {
    const { app, other } = await setup({ 'auth.md': BASE })
    const ws = await openWorkspace(app)
    const { text } = await openReplica(ws, 'auth.md')
    text.insert(0, 'Local: ')
    await ws.commit('local')
    await writeFile(path.join(other, 'auth.md'), `${BASE}Remote.\n`)
    git(other, 'commit', '-am', 'remote')
    git(other, 'push')

    expect(await ws.pull()).toMatchObject({ ok: false, message: expect.stringContaining('diverged') })
  })
})

describe('branch comparison', () => {
  it('compares with a chosen branch, and falls back to the default when it is gone, saying so', async () => {
    const { app } = await setup({ 'a.md': 'one\n' })
    const seed = git(app, 'rev-parse', 'HEAD').trim()
    git(app, 'switch', '-q', '-c', 'other')
    git(app, 'switch', '-q', 'main')
    await writeFile(path.join(app, 'b.md'), 'b\n')
    git(app, 'add', '-A')
    git(app, 'commit', '-qm', 'b')
    const ws = await openWorkspace(app)
    const byDefault = await ws.branch()
    expect(byDefault.missingBase).toBeNull()
    expect(byDefault.base).toEqual({ sha: seed, label: 'origin/main' })
    expect((await ws.branch('other')).base).toEqual({ sha: seed, label: 'other' })
    const gone = await ws.branch('gone')
    expect(gone.missingBase).toBe('gone')
    expect(gone.base).toEqual(byDefault.base)
    await expect(ws.branch('-x')).rejects.toThrow()
    expect(await ws.branches()).toEqual(expect.arrayContaining(['main', 'other', 'origin/main']))
  })
})

describe('staging', () => {
  it('commits only the staged doc, and a doc staged then edited further still pulls', async () => {
    const { app, other } = await setup({ 'auth.md': BASE, 'notes.md': '# Notes\n' })
    const replicas = new Map<string, Y.Doc>()
    const ws = await openWorkspace(app, replicas)
    const auth = await openReplica(ws, 'auth.md')
    const notes = await openReplica(ws, 'notes.md')
    replicas.set('auth.md', auth.doc)
    replicas.set('notes.md', notes.doc)
    auth.text.insert(auth.text.toString().indexOf('magic'), 'passwordless ')
    notes.text.insert(notes.text.length, 'Unstaged note.\n')
    await ws.idle()
    const staged = auth.text.toString()

    expect(await ws.stage(['auth.md'])).toMatchObject({ ok: true })
    auth.text.insert(auth.text.length, 'Typed after staging.\n')
    expect(await ws.commit('docs: passwordless', 'staged')).toMatchObject({ ok: true })

    expect(git(app, 'show', 'HEAD:auth.md')).toBe(staged)
    expect(git(app, 'show', 'HEAD:notes.md')).toBe('# Notes\n')
    expect(git(app, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([' M auth.md', ' M notes.md'])

    git(app, 'push')
    git(other, 'pull', '-q')
    await writeFile(path.join(other, 'auth.md'), staged.replace('# Auth', '# Authentication'))
    git(other, 'commit', '-am', 'teammate edit')
    git(other, 'push', '-q')

    expect(await ws.pull()).toMatchObject({ ok: true })
    await ws.idle()
    expect(auth.text.toString()).toBe(`${staged.replace('# Auth', '# Authentication')}Typed after staging.\n`)
  })

  it('stages and unstages a doc but never its thread records, which stay out of git', async () => {
    const { app } = await setup({ 'auth.md': BASE })
    const ws = await openWorkspace(app)
    const { text } = await openReplica(ws, 'auth.md')
    const thread = await ws.threads.createAt('auth.md', text.toString().indexOf('Sessions'), 'Session length')
    text.insert(text.length, 'More.\n')
    await ws.idle()

    await ws.stage(['auth.md'])
    expect((await ws.changes()).staged.map((change) => change.path)).toEqual(['auth.md'])
    expect((await ws.changes()).unstaged.map((change) => change.path)).not.toContain(`.manta/threads/${thread.id}.json`)

    await ws.unstage(['auth.md'])
    expect((await ws.changes()).staged).toEqual([])
  })

  it('commits everything when nothing is staged', async () => {
    const { app } = await setup({ 'auth.md': BASE })
    await writeFile(path.join(app, 'new.md'), '# New\n')
    const ws = await openWorkspace(app)

    expect(await ws.commit('docs: everything', 'staged')).toMatchObject({ ok: true })

    expect(git(app, 'status', '--porcelain')).toBe('')
  })

  it('discards after confirming: restores the doc in the editor and deletes untracked files', async () => {
    const { app } = await setup({ 'auth.md': BASE })
    const replicas = new Map<string, Y.Doc>()
    const ws = await openWorkspace(app, replicas)
    const { doc, text } = await openReplica(ws, 'auth.md')
    replicas.set('auth.md', doc)
    text.insert(text.length, 'Draft line.\n')
    await writeFile(path.join(app, 'scratch.md'), 'scratch\n')

    expect(await ws.discardChanges(['auth.md', 'scratch.md'], async () => false)).toBeNull()
    await ws.idle()
    expect(await readFile(path.join(app, 'auth.md'), 'utf8')).toBe(`${BASE}Draft line.\n`)
    expect(await readFile(path.join(app, 'scratch.md'), 'utf8')).toBe('scratch\n')

    const asked: unknown[] = []
    const result = await ws.discardChanges(['auth.md', 'scratch.md'], async (summary) => {
      asked.push(summary)
      return true
    })
    await ws.idle()

    expect(result).toMatchObject({ ok: true })
    expect(asked).toEqual([{ paths: ['auth.md', 'scratch.md'], deleted: 1, docsWithThreads: [] }])
    expect(text.toString()).toBe(BASE)
    expect(git(app, 'status', '--porcelain')).toBe('')
  })
})
