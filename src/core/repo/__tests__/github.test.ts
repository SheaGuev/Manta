import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PullRequestDetail } from '../../../shared/ipc'
import { ghPullRequestDetail, ghPullRequests, ghRunner, parsePullRequestDetail, parsePullRequests, parseViewedFiles, type GhResult, type GhRunner } from '../github'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A stand-in `gh` that logs its arguments and prints `output`, or fails. */
async function fakeGh(output: string | null): Promise<{ gh: string; calls: () => Promise<string[]>; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'manta-gh-'))
  dirs.push(dir)
  const gh = path.join(dir, 'gh')
  const log = path.join(dir, 'calls.log')
  const body = output === null ? 'echo "not logged in" >&2; exit 1' : `cat <<'JSON'\n${output}\nJSON`
  await writeFile(gh, `#!/bin/sh\necho "$*" >> ${log}\necho "prompt=$GH_PROMPT_DISABLED" >> ${log}\ncat >> ${log}\necho >> ${log}\n${body}\n`)
  await chmod(gh, 0o755)
  const calls = async (): Promise<string[]> =>
    (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((line) => line && !line.startsWith('prompt='))
  return { gh, calls, dir }
}

const env = async (): Promise<Record<string, string>> => ({ PATH: process.env['PATH'] ?? '/usr/bin:/bin' })

describe('parsePullRequests', () => {
  it('reads the first pull request, none, and refuses output it does not recognise', () => {
    expect(parsePullRequests('[{"number":12,"state":"MERGED","url":"https://github.com/o/r/pull/12"}]')).toEqual({
      number: 12,
      state: 'merged',
      url: 'https://github.com/o/r/pull/12'
    })
    expect(parsePullRequests('[]')).toBeNull()
    expect(parsePullRequests('[{"number":12,"state":"DRAFT","url":"u"}]')).toBeUndefined()
    expect(parsePullRequests('[{"state":"OPEN","url":"u"}]')).toBeUndefined()
    expect(parsePullRequests('{"message":"Not Found"}')).toBeUndefined()
    expect(parsePullRequests('not json')).toBeUndefined()
  })
})

describe('ghPullRequests', () => {
  it("asks gh for the branch's newest pull request in any state, and reuses the answer for a while", async () => {
    const { gh, calls } = await fakeGh('[{"number":7,"state":"OPEN","url":"https://github.com/o/r/pull/7"}]')
    const lookup = ghPullRequests({ gh: () => gh, env })
    expect(await lookup(tmpdir(), 'manta/login')).toEqual({ found: { number: 7, state: 'open', url: 'https://github.com/o/r/pull/7' } })
    expect(await lookup(tmpdir(), 'manta/login')).toEqual({ found: { number: 7, state: 'open', url: 'https://github.com/o/r/pull/7' } })
    expect(await calls()).toEqual(['pr list --head manta/login --state all --json number,state,url --limit 1'])
  })

  it('says it could not ask when gh is missing or fails, rather than reporting no pull request', async () => {
    const { gh } = await fakeGh(null)
    expect(await ghPullRequests({ gh: () => gh, env })(tmpdir(), 'manta/login')).toBeNull()
    expect(await ghPullRequests({ gh: () => null, env })(tmpdir(), 'manta/login')).toBeNull()
  })
})

const fixture = (name: string): Promise<string> => readFile(path.join(__dirname, 'fixtures', name), 'utf8')

const expectedDetail: PullRequestDetail = {
  id: 'PR_kwDOAAAB',
  number: 7,
  title: 'Add login',
  state: 'open',
  url: 'https://github.com/o/r/pull/7',
  baseRefName: 'main',
  baseRefOid: '1111111111111111111111111111111111111111',
  headRefName: 'feature/login',
  headRefOid: '2222222222222222222222222222222222222222',
  author: 'alice',
  viewer: 'me',
  checks: [
    { name: 'test', state: 'passed', url: 'https://github.com/o/r/actions/runs/1/job/1' },
    { name: 'lint', state: 'failed', url: 'https://github.com/o/r/actions/runs/1/job/2' },
    { name: 'build', state: 'running', url: 'https://github.com/o/r/actions/runs/1/job/3' },
    { name: 'deploy/preview', state: 'running', url: null }
  ],
  comments: [
    {
      id: 'PRRT_1',
      kind: 'thread',
      author: 'dave',
      body: 'Handle the error here',
      url: 'https://github.com/o/r/pull/7#discussion_r1',
      createdAt: '2026-10-22T10:00:00Z',
      path: 'src/login.ts',
      line: 14,
      side: 'new',
      hunk: '@@ -10,3 +10,5 @@\n const a = 1\n+const b = 2',
      resolved: false,
      outdated: false,
      replies: [{ author: 'alice', body: 'Will do', createdAt: '2026-10-22T11:00:00Z' }],
      verdict: null
    },
    {
      id: 'PRRT_2',
      kind: 'thread',
      author: 'carol',
      body: 'Why remove this?',
      url: 'https://github.com/o/r/pull/7#discussion_r3',
      createdAt: '2026-10-21T10:00:00Z',
      path: 'src/app.ts',
      line: 3,
      side: 'old',
      hunk: '@@ -1,4 +1,3 @@\n-import x',
      resolved: true,
      outdated: false,
      replies: [],
      verdict: null
    },
    {
      id: 'PRRT_3',
      kind: 'thread',
      author: 'ghost',
      body: 'Typo',
      url: 'https://github.com/o/r/pull/7#discussion_r4',
      createdAt: '2026-10-20T10:00:00Z',
      path: 'src/old.ts',
      line: 12,
      side: 'new',
      hunk: '@@ -12 +12 @@\n+teh',
      resolved: false,
      outdated: true,
      replies: [],
      verdict: null
    },
    {
      id: 'IC_1',
      kind: 'comment',
      author: 'carol',
      body: 'Can we split this PR?',
      url: 'https://github.com/o/r/pull/7#issuecomment-1',
      createdAt: '2026-10-20T10:00:00Z',
      path: null,
      line: null,
      side: null,
      hunk: null,
      resolved: false,
      outdated: false,
      replies: [],
      verdict: null
    },
    {
      id: 'IC_2',
      kind: 'comment',
      author: 'ghost',
      body: 'Looks fine',
      url: 'https://github.com/o/r/pull/7#issuecomment-2',
      createdAt: '2026-10-21T10:00:00Z',
      path: null,
      line: null,
      side: null,
      hunk: null,
      resolved: false,
      outdated: false,
      replies: [],
      verdict: null
    },
    {
      id: 'PRR_1',
      kind: 'review',
      author: 'dave',
      body: 'Needs tests',
      url: 'https://github.com/o/r/pull/7',
      createdAt: '2026-10-22T10:00:00Z',
      path: null,
      line: null,
      side: null,
      hunk: null,
      resolved: false,
      outdated: false,
      replies: [],
      verdict: 'changes requested'
    }
  ],
  truncated: false
}

describe('parsePullRequestDetail', () => {
  it('reads a PR with its checks, threads, conversation and reviews', async () => {
    expect(parsePullRequestDetail(await fixture('pr-view.json'), await fixture('pr-threads.json'))).toEqual(expectedDetail)
  })

  it('reads a draft as draft and refuses output it does not recognise', async () => {
    const view = JSON.parse(await fixture('pr-view.json'))
    const threads = await fixture('pr-threads.json')
    expect(parsePullRequestDetail(JSON.stringify({ ...view, isDraft: true }), threads)?.state).toBe('draft')
    expect(parsePullRequestDetail('{}', threads)).toBeUndefined()
    expect(parsePullRequestDetail('[]', threads)).toBeUndefined()
    expect(parsePullRequestDetail('not json', threads)).toBeUndefined()
    expect(parsePullRequestDetail(JSON.stringify(view), '{"data":{}}')).toBeUndefined()
  })
})

/** A runner that answers from canned output by the command's first two words, and records every call. */
function stubRunner(answers: Record<string, GhResult>): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = []
  const run: GhRunner = async (_cwd, args) => {
    calls.push([...args])
    return answers[`${args[0]} ${args[1]}`] ?? { ok: false, message: `no answer for ${args.join(' ')}` }
  }
  return { run, calls }
}

describe('ghPullRequestDetail', () => {
  it('runs list, view and graphql in order, and caches the answer for a minute unless forced', async () => {
    const { run, calls } = stubRunner({
      'pr list': { ok: true, stdout: '[{"number":7}]' },
      'pr view': { ok: true, stdout: await fixture('pr-view.json') },
      'api graphql': { ok: true, stdout: await fixture('pr-threads.json') }
    })
    const detail = ghPullRequestDetail(run)
    expect(await detail('/repo', 'feature/login')).toEqual({ found: expectedDetail })
    expect(await detail('/repo', 'feature/login')).toEqual({ found: expectedDetail })
    expect(calls.map((call) => call.slice(0, 3))).toEqual([
      ['pr', 'list', '--head'],
      ['pr', 'view', '7'],
      ['api', 'graphql', '-F']
    ])
    expect(calls[0]).toEqual(['pr', 'list', '--head', 'feature/login', '--state', 'all', '--json', 'number', '--limit', '1'])
    expect(calls[1]).toEqual([
      'pr',
      'view',
      '7',
      '--json',
      'id,number,title,state,isDraft,url,baseRefName,baseRefOid,headRefName,headRefOid,author,comments,reviews,statusCheckRollup'
    ])
    expect(calls[2]?.slice(0, 8)).toEqual(['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', 'number=7'])
    await detail('/repo', 'feature/login', { force: true })
    expect(calls).toHaveLength(6)
  })

  it('reports a failed gh as failed, never as no PR', async () => {
    const failing = stubRunner({
      'pr list': { ok: true, stdout: '[{"number":7}]' },
      'pr view': { ok: true, stdout: await fixture('pr-view.json') },
      'api graphql': { ok: false, message: 'HTTP 401' }
    })
    expect(await ghPullRequestDetail(failing.run)('/repo', 'b')).toEqual({ failed: 'HTTP 401' })
    const none = stubRunner({ 'pr list': { ok: true, stdout: '[]' } })
    expect(await ghPullRequestDetail(none.run)('/repo', 'b')).toEqual({ found: null })
    const garbled = stubRunner({ 'pr list': { ok: true, stdout: '[{"number":3}]' }, 'pr view': { ok: true, stdout: '{}' }, 'api graphql': { ok: true, stdout: '{}' } })
    expect(await ghPullRequestDetail(garbled.run)('/repo', 'b')).toEqual({ failed: "gh's answer wasn't understood" })
  })
})

describe('ghRunner', () => {
  it('runs gh without prompts and passes stdin through', async () => {
    const { gh, dir } = await fakeGh('ok')
    expect(await ghRunner({ gh: () => gh, env })(dir, ['api', 'x', '--input', '-'], '{"a":1}')).toEqual({ ok: true, stdout: 'ok\n' })
    const log = await readFile(path.join(dir, 'calls.log'), 'utf8')
    expect(log).toContain('prompt=1')
    expect(log).toContain('{"a":1}')
    expect(await ghRunner({ gh: () => null, env })(dir, ['pr', 'list'])).toEqual({ ok: false, message: "gh isn't installed" })
  })

  it("returns gh's own error message", async () => {
    const { gh, dir } = await fakeGh(null)
    expect(await ghRunner({ gh: () => gh, env })(dir, ['pr', 'list'])).toEqual({ ok: false, message: 'not logged in' })
  })
})

describe('parseViewedFiles', () => {
  it('reads viewed states and skips unknown ones', () => {
    const output = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            files: {
              nodes: [
                { path: 'a.ts', viewerViewedState: 'VIEWED' },
                { path: 'b.ts', viewerViewedState: 'UNVIEWED' },
                { path: 'c.ts', viewerViewedState: 'DISMISSED' },
                { path: 'd.ts', viewerViewedState: 'SOMETHING' },
                { viewerViewedState: 'VIEWED' }
              ]
            }
          }
        }
      }
    })
    expect(Object.fromEntries(parseViewedFiles(output) ?? [])).toEqual({ 'a.ts': 'VIEWED', 'b.ts': 'UNVIEWED', 'c.ts': 'DISMISSED' })
    expect(parseViewedFiles('{}')).toBeUndefined()
    expect(parseViewedFiles('nope')).toBeUndefined()
  })
})
