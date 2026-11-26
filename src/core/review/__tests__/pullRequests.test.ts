import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Git } from '../../repo/git'
import type { GhResult, GhRunner } from '../../repo/github'
import { PullRequests, hasGitHubRemote, prBaseName, repoOfUrl } from '../pullRequests'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const fixture = (name: string): Promise<string> => readFile(path.join(__dirname, '../../repo/__tests__/fixtures', name), 'utf8')

/** A worktree cloned from a bare origin, with a GitHub-looking remote URL beside it for the remote check. */
async function setup(): Promise<{ origin: string; dir: string; run: (...args: string[]) => string; git: Git }> {
  const base = await mkdtemp(path.join(tmpdir(), 'manta-prs-'))
  dirs.push(base)
  const origin = path.join(base, 'origin.git')
  const dir = path.join(base, 'work')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, dir])
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  run('config', 'user.name', 't')
  run('config', 'user.email', 't@t')
  run('remote', 'add', 'github', 'git@github.com:o/r.git')
  await writeFile(path.join(dir, 'a.md'), 'seed\n')
  run('add', '-A')
  run('commit', '-qm', 'seed')
  run('push', '-q', 'origin', 'main')
  run('checkout', '-q', '-b', 'feature')
  await writeFile(path.join(dir, 'a.md'), 'login\n')
  run('commit', '-qam', 'Add the login form')
  return { origin, dir, run, git: new Git(dir) }
}

/** Answers each call with the first matching rule (by the command's leading words), and records it. */
function stub(rules: [string, GhResult | (() => GhResult)][]): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = []
  const run: GhRunner = async (_cwd, args) => {
    calls.push([...args])
    const rule = rules.find(([prefix]) => args.join(' ').startsWith(prefix))
    if (!rule) return { ok: false, message: `unexpected gh ${args.join(' ')}` }
    return typeof rule[1] === 'function' ? rule[1]() : rule[1]
  }
  return { run, calls }
}

const NO_PR: [string, GhResult] = ['pr list', { ok: true, stdout: '[]' }]
const CREATED: [string, GhResult] = ['pr create', { ok: true, stdout: 'https://github.com/o/r/pull/8\n' }]

describe('hasGitHubRemote and prBaseName', () => {
  it('reads GitHub remotes in ssh and https form, and nothing else', () => {
    expect(hasGitHubRemote(['git@github.com:o/r.git'])).toBe(true)
    expect(hasGitHubRemote(['ssh://git@github.com/o/r'])).toBe(true)
    expect(hasGitHubRemote(['https://github.com/o/r'])).toBe(true)
    expect(hasGitHubRemote(['https://someone@github.com/o/r.git'])).toBe(true)
    expect(hasGitHubRemote(['https://gitlab.com/o/r', '/tmp/origin.git', 'https://notgithub.com/o/r'])).toBe(false)
    expect(hasGitHubRemote([])).toBe(false)
  })

  it("strips a remote's name from a base", () => {
    expect(prBaseName('origin/main')).toBe('main')
    expect(prBaseName('main')).toBe('main')
    expect(prBaseName('origin/release/1.2')).toBe('release/1.2')
    expect(prBaseName('upstream/main', ['origin', 'upstream'])).toBe('main')
    expect(prBaseName('feature/x', ['origin', 'upstream'])).toBe('feature/x')
  })
})

describe('repoOfUrl', () => {
  it('reads owner/repo from any remote URL or a pull request URL', () => {
    expect(repoOfUrl('git@github.com:Acme/Widget.git')).toBe('Acme/Widget')
    expect(repoOfUrl('git@github-work:acme/widget')).toBe('acme/widget')
    expect(repoOfUrl('ssh://git@github.com/acme/widget.git/')).toBe('acme/widget')
    expect(repoOfUrl('https://me@github.com/acme/widget')).toBe('acme/widget')
    expect(repoOfUrl('https://github.com/acme/widget/pull/7')).toBe('acme/widget')
    expect(repoOfUrl('/tmp/x/acme/widget.git')).toBe('acme/widget')
    expect(repoOfUrl('widget')).toBeNull()
  })
})

describe('PullRequests.status', () => {
  it('says why the tab cannot work: no gh, no GitHub remote, detached HEAD, gh failed', async () => {
    const { run, git, dir } = await setup()
    const ok = stub([NO_PR])
    expect(await new PullRequests({ run: ok.run, ghInstalled: () => false }).status(dir, git)).toEqual({
      kind: 'unavailable',
      reason: "Install GitHub's gh and run gh auth login to see pull requests"
    })
    expect(await new PullRequests({ run: ok.run, ghInstalled: () => true }).status(dir, git)).toEqual({ kind: 'none', branch: 'feature' })

    const failing = stub([['pr list', { ok: false, message: 'To get started with GitHub CLI, please run: gh auth login' }]])
    expect(await new PullRequests({ run: failing.run, ghInstalled: () => true }).status(dir, git)).toEqual({
      kind: 'unavailable',
      reason: 'To get started with GitHub CLI, please run: gh auth login'
    })

    run('checkout', '-q', '--detach')
    expect(await new PullRequests({ run: ok.run, ghInstalled: () => true }).status(dir, git)).toEqual({ kind: 'unavailable', reason: 'Not on a branch' })

    run('checkout', '-q', 'feature')
    run('remote', 'remove', 'github')
    const noHost = stub([['pr list', { ok: false, message: 'none of the git remotes configured for this repository point to a known GitHub host' }]])
    expect(await new PullRequests({ run: noHost.run, ghInstalled: () => true }).status(dir, git)).toEqual({ kind: 'unavailable', reason: 'This repo has no GitHub remote' })
  })

  it('leaves remotes it cannot place, like an ssh host alias, to gh', async () => {
    const { run, git, dir } = await setup()
    run('remote', 'set-url', 'github', 'git@github-work:o/r.git')
    const { run: gh } = stub([
      ['pr list', { ok: true, stdout: '[{"number":7}]' }],
      ['pr view', { ok: true, stdout: await fixture('pr-view.json') }],
      ['api graphql', { ok: true, stdout: await fixture('pr-threads.json') }]
    ])
    expect((await new PullRequests({ run: gh, ghInstalled: () => true }).status(dir, git)).kind).toBe('found')
  })

  it('reads a found PR and keeps it for sending', async () => {
    const { git, dir } = await setup()
    const { run } = stub([
      ['pr list', { ok: true, stdout: '[{"number":7}]' }],
      ['pr view', { ok: true, stdout: await fixture('pr-view.json') }],
      ['api graphql', { ok: true, stdout: await fixture('pr-threads.json') }]
    ])
    const prs = new PullRequests({ run, ghInstalled: () => true })
    expect(prs.cached(dir)).toBeNull()
    const status = await prs.status(dir, git)
    expect(status.kind === 'found' && status.pr.number).toBe(7)
    expect(prs.cached(dir)?.number).toBe(7)
  })
})

describe('PullRequests drafts', () => {
  it('defaults the draft title to the last commit subject and the base to the chosen or default branch without origin/', async () => {
    const { git } = await setup()
    const prs = new PullRequests({ run: stub([]).run, ghInstalled: () => true })
    expect(await prs.draftDefaults(git, null)).toEqual({ title: 'Add the login form', base: 'main' })
    expect(await prs.draftDefaults(git, 'origin/release')).toEqual({ title: 'Add the login form', base: 'release' })
  })

  it('pushes a branch with no upstream, then creates the draft PR without prompting', async () => {
    const { git, dir, origin } = await setup()
    const { run, calls } = stub([NO_PR, CREATED])
    const result = await new PullRequests({ run, ghInstalled: () => true }).createDraft(dir, git, { title: 'T', body: '', base: 'main' })
    expect(result).toEqual({ ok: true, message: 'Draft PR created: https://github.com/o/r/pull/8' })
    expect(execFileSync('git', ['log', '-1', '--format=%s', 'feature'], { cwd: origin, encoding: 'utf8' }).trim()).toBe('Add the login form')
    expect(calls.filter((args) => args[0] === 'pr')).toEqual([['pr', 'create', '--draft', '--title', 'T', '--body', '', '--base', 'main', '--head', 'feature']])
  })

  it("names the head with its owner when the branch is pushed to a fork of the PR's repo", async () => {
    const { git, dir, origin } = await setup()
    const forkOwner = path.basename(path.dirname(origin))
    const asked = (nameWithOwner: string) => stub([['repo view', { ok: true, stdout: JSON.stringify({ nameWithOwner }) }], CREATED])
    const fork = asked('Acme/Widget')
    expect((await new PullRequests({ run: fork.run, ghInstalled: () => true }).createDraft(dir, git, { title: 'T', body: '', base: 'main' })).ok).toBe(true)
    expect(fork.calls.find((args) => args[1] === 'create')?.slice(-2)).toEqual(['--head', `${forkOwner}:feature`])
    const same = asked(`${forkOwner}/origin`)
    expect((await new PullRequests({ run: same.run, ghInstalled: () => true }).createDraft(dir, git, { title: 'T', body: '', base: 'main' })).ok).toBe(true)
    expect(same.calls.find((args) => args[1] === 'create')?.slice(-2)).toEqual(['--head', 'feature'])
  })

  it('pushes unpushed commits on a branch that already has an upstream', async () => {
    const { git, dir, origin, run } = await setup()
    run('push', '-q', '-u', 'origin', 'feature')
    await writeFile(path.join(dir, 'a.md'), 'more\n')
    run('commit', '-qam', 'More')
    const result = await new PullRequests({ run: stub([CREATED]).run, ghInstalled: () => true }).createDraft(dir, git, { title: 'T', body: 'B', base: 'main' })
    expect(result.ok).toBe(true)
    expect(execFileSync('git', ['log', '-1', '--format=%s', 'feature'], { cwd: origin, encoding: 'utf8' }).trim()).toBe('More')
  })

  it("shows git's message and creates no PR when the push is refused", async () => {
    const { git, dir, origin, run } = await setup()
    run('push', '-q', '-u', 'origin', 'feature')
    const other = path.join(path.dirname(origin), 'other')
    execFileSync('git', ['clone', '-q', '-b', 'feature', origin, other])
    const runOther = (...args: string[]) => execFileSync('git', args, { cwd: other, encoding: 'utf8' })
    runOther('config', 'user.name', 't')
    runOther('config', 'user.email', 't@t')
    await writeFile(path.join(other, 'b.md'), 'theirs\n')
    runOther('add', '-A')
    runOther('commit', '-qm', 'Theirs')
    runOther('push', '-q', 'origin', 'feature')
    await writeFile(path.join(dir, 'a.md'), 'mine\n')
    run('commit', '-qam', 'Mine')

    const { run: gh, calls } = stub([CREATED])
    const result = await new PullRequests({ run: gh, ghInstalled: () => true }).createDraft(dir, git, { title: 'T', body: '', base: 'main' })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/rejected|fetch first|non-fast-forward/)
    expect(calls).toEqual([])
  })

  it('refuses an empty title and a base equal to the branch', async () => {
    const { git, dir } = await setup()
    const { run, calls } = stub([CREATED])
    const prs = new PullRequests({ run, ghInstalled: () => true })
    expect(await prs.createDraft(dir, git, { title: '  ', body: '', base: 'main' })).toEqual({ ok: false, message: 'Give the PR a title' })
    expect(await prs.createDraft(dir, git, { title: 'T', body: '', base: 'feature' })).toEqual({ ok: false, message: 'Pick a base other than this branch' })
    expect(calls).toEqual([])
  })

  it('finds a PR created a moment ago instead of the cached none', async () => {
    const { git, dir } = await setup()
    let created = false
    const { run } = stub([
      ['pr list', () => ({ ok: true, stdout: created ? '[{"number":7}]' : '[]' })],
      ['pr create', () => ((created = true), { ok: true, stdout: 'https://github.com/o/r/pull/7\n' })],
      ['pr view', { ok: true, stdout: await fixture('pr-view.json') }],
      ['api graphql', { ok: true, stdout: await fixture('pr-threads.json') }]
    ])
    const prs = new PullRequests({ run, ghInstalled: () => true })
    expect((await prs.status(dir, git)).kind).toBe('none')
    expect((await prs.createDraft(dir, git, { title: 'T', body: '', base: 'main' })).ok).toBe(true)
    expect((await prs.status(dir, git)).kind).toBe('found')
  })
})
