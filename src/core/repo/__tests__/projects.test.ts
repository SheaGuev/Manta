import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectRegistry } from '../projects'

const dirs: string[] = []
const registries: ProjectRegistry[] = []
afterEach(async () => {
  for (const r of registries.splice(0)) await r.closeAll()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'manta-proj-')))
  dirs.push(dir)
  return dir
}

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await tempDir()
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir })
  run('init', '-q', '-b', 'main')
  run('config', 'user.name', 't')
  run('config', 'user.email', 't@t')
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text)
  run('add', '-A')
  run('commit', '-qm', 'seed')
  return dir
}

async function registry(appData: string): Promise<ProjectRegistry> {
  const r = await ProjectRegistry.load({
    settingsFile: path.join(appData, 'settings.json'),
    worktreesDir: path.join(appData, 'worktrees'),
    onUpdate: () => {}
  })
  registries.push(r)
  return r
}

describe('ProjectRegistry', () => {
  it('keeps one docs project first, persists projects, and replaces the docs repo', async () => {
    const appData = await tempDir()
    const docs = await repo({ 'a.md': '# A\n' })
    const otherDocs = await repo({ 'b.md': '# B\n' })
    const code = await repo({ 'x.ts': 'x\n' })
    const first = await registry(appData)
    await first.add(code, 'code')
    await first.add(docs, 'docs')
    expect(first.list().map((p) => [p.root, p.kind])).toEqual([
      [docs, 'docs'],
      [code, 'code']
    ])

    await first.add(otherDocs, 'docs')
    const reloaded = await registry(appData)
    expect(reloaded.list().map((p) => p.root)).toEqual([otherDocs, code])
  })

  it('closes the old docs repo when another replaces it, and stops allowing it', async () => {
    const appData = await tempDir()
    const docs = await repo({ 'a.md': '# A\n' })
    const otherDocs = await repo({ 'b.md': '# B\n' })
    const closed: string[] = []
    const r = await ProjectRegistry.load({
      settingsFile: path.join(appData, 'settings.json'),
      worktreesDir: path.join(appData, 'worktrees'),
      onUpdate: () => {},
      onWorkspaceClosed: (root) => closed.push(root)
    })
    registries.push(r)
    await r.add(docs, 'docs')
    await r.workspace(docs)

    await r.add(otherDocs, 'docs')
    expect(closed).toEqual([docs])
    await expect(r.workspace(docs)).rejects.toThrow(/not a project/)
    expect((await r.workspace(otherDocs)).repoRoot).toBe(otherDocs)

    await r.add(otherDocs, 'docs')
    expect(closed).toEqual([docs])
  })

  it('migrates the step 1 lastFolder setting to the docs project', async () => {
    const appData = await tempDir()
    const docs = await repo({ 'a.md': '# A\n' })
    await writeFile(path.join(appData, 'settings.json'), JSON.stringify({ lastFolder: docs }))
    expect((await registry(appData)).list()).toEqual([{ root: docs, name: path.basename(docs), kind: 'docs' }])
  })

  it('creates worktrees in the app dir and opens workspaces only for projects and their worktrees', async () => {
    const appData = await tempDir()
    const code = await repo({ 'x.ts': 'x\n' })
    const stranger = await repo({ 'y.ts': 'y\n' })
    const r = await registry(appData)
    await r.add(code, 'code')

    const worktree = await r.createWorktree(code, 'Fix Login Bug!')
    expect(worktree.branch).toBe('manta/fix-login-bug')
    expect(worktree.path.startsWith(await realpath(path.join(appData, 'worktrees')))).toBe(true)
    expect((await r.worktrees(code)).map((w) => w.branch)).toEqual(['main', 'manta/fix-login-bug'])

    expect(await (await r.workspace(worktree.path)).listFiles('all')).toEqual(['x.ts'])
    await expect(r.workspace(stranger)).rejects.toThrow('not a project')
    await expect(r.createWorktree(code, 'fix login bug')).rejects.toThrow('already exists')
  })

  it('removes a clean Manta worktree after confirming, keeping its branch', async () => {
    const appData = await tempDir()
    const code = await repo({ 'x.ts': 'x\n' })
    const r = await registry(appData)
    await r.add(code, 'code')
    const worktree = await r.createWorktree(code, 'spike')
    expect(worktree.managed).toBe(true)
    expect((await r.worktrees(code)).find((w) => w.isMain)?.managed).toBe(false)
    await r.workspace(worktree.path)

    expect(await r.removeWorktree(code, worktree.path, async () => false)).toBeNull()
    expect((await r.worktrees(code)).map((w) => w.branch)).toEqual(['main', 'manta/spike'])

    const asked: string[] = []
    const result = await r.removeWorktree(code, worktree.path, async (w) => {
      asked.push(w.path)
      return true
    })
    expect(result).toEqual({ ok: true, message: 'Removed worktree spike; branch manta/spike kept' })
    expect(asked).toEqual([worktree.path])
    expect((await r.worktrees(code)).map((w) => w.branch)).toEqual(['main'])
    expect(execFileSync('git', ['branch', '--list', 'manta/spike'], { cwd: code, encoding: 'utf8' })).toContain('manta/spike')
    await expect(r.workspace(worktree.path)).rejects.toThrow()
  })

  it('refuses to remove a worktree with untracked files, or one Manta did not create, without asking', async () => {
    const appData = await tempDir()
    const code = await repo({ 'x.ts': 'x\n' })
    const r = await registry(appData)
    await r.add(code, 'code')
    const worktree = await r.createWorktree(code, 'dirty')
    await writeFile(path.join(worktree.path, 'notes.txt'), 'draft\n')
    const outside = path.join(await tempDir(), 'by-hand')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'by-hand', outside], { cwd: code })
    const confirm = async (): Promise<boolean> => {
      throw new Error('should not ask')
    }

    expect(await r.removeWorktree(code, worktree.path, confirm)).toMatchObject({ ok: false, message: expect.stringContaining('untracked') })
    expect(await r.removeWorktree(code, outside, confirm)).toMatchObject({ ok: false, message: expect.stringContaining('only removes worktrees it created') })
    await expect(r.removeWorktree(code, code, confirm)).resolves.toMatchObject({ ok: false })
    expect((await r.worktrees(code)).map((w) => w.branch).sort()).toEqual(['by-hand', 'main', 'manta/dirty'])
  })

  it('rejects folders that are not a repo root', async () => {
    const r = await registry(await tempDir())
    await expect(r.add(await tempDir(), 'code')).rejects.toThrow('not the top-level folder')
  })
})
