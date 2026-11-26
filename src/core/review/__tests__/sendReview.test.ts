import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PullRequestComment, PullRequestDetail, ReviewAnchor, ReviewTarget } from '../../../shared/ipc'
import { TerminalManager } from '../../terminal/terminals'
import { ReviewCommentStore } from '../reviewComments'
import { sendPullRequestComments, sendReview, sendReviewDraft } from '../sendReview'

const FAKE_CLAUDE = fileURLToPath(new URL('../../../../scripts/fake-claude.mjs', import.meta.url))
const SIZE = { cols: 100, rows: 30 }
/** A fake session plus a hook round trip; a loaded machine passes waitFor's default second. */
const slow = { timeout: 5000 }
const ANCHOR: ReviewAnchor = { relPath: 'src/a.ts', diff: 'branch', side: 'new', line: 3, lineText: 'const a = 1', hunk: '+const a = 1' }

const dirs: string[] = []
const managers: TerminalManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'manta-review-send-')))
  dirs.push(dir)
  return dir
}

async function setup(): Promise<{ terminals: TerminalManager; output: (id: string) => string; store: ReviewCommentStore; root: string }> {
  const appData = await tempDir()
  const root = await tempDir()
  const chunks = new Map<string, string>()
  const terminals = await TerminalManager.open({
    recordsFile: path.join(appData, 'terminals.json'),
    settingsFile: path.join(appData, 'terminal-settings.json'),
    hookSettingsFile: path.join(appData, 'hooks', 'claude-settings.json'),
    claude: () => ({ file: process.execPath, args: [FAKE_CLAUDE] }),
    shell: '/bin/sh',
    baseEnv: async () => ({ PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: appData }),
    onData: (id, data) => chunks.set(id, (chunks.get(id) ?? '') + data),
    onChange: () => undefined,
    onRemoved: () => undefined
  })
  managers.push(terminals)
  const store = new ReviewCommentStore(async () => path.join(appData, 'review-comments.json'))
  return { terminals, output: (id) => chunks.get(id) ?? '', store, root }
}

const stateOf = (terminals: TerminalManager, id: string) => terminals.list().find((t) => t.id === id)?.state

describe('sendReview', () => {
  it('pastes the formatted comments into the chosen session and marks them sent to it', async () => {
    const { terminals, output, store, root } = await setup()
    const claude = await terminals.create(root, 'claude', SIZE)
    await vi.waitFor(() => expect(stateOf(terminals, claude.id)).toBe('idle'), slow)
    const first = await store.add(ANCHOR, 'Rename this')
    const second = await store.add({ ...ANCHOR, line: 9 }, 'And this')
    const kept = await store.add({ ...ANCHOR, line: 12 }, 'Not now')

    const result = await sendReview({ store, terminals, root, ids: [first.id, second.id, 'rc_unknown'], target: { terminal: claude.id }, size: SIZE })
    expect(result).toEqual({ ok: true, message: 'Sent to Claude' })
    await vi.waitFor(() => expect(output(claude.id)).toContain(`Scripted reply to: Review comments on your changes in ${path.basename(root)}:`), slow)
    const comments = await store.list()
    expect(comments.filter((c) => c.sent?.to === 'Claude').map((c) => c.id)).toEqual([first.id, second.id])
    expect(comments.find((c) => c.id === kept.id)?.sent).toBeNull()
  })

  it('starts a new session with the comments as its first prompt', async () => {
    const { terminals, output, store, root } = await setup()
    const comment = await store.add(ANCHOR, 'Rename this')

    const result = await sendReview({ store, terminals, root, ids: [comment.id], target: { newSession: true }, size: SIZE })
    expect(result.ok).toBe(true)
    const created = terminals.list().filter((t) => t.kind === 'claude' && t.root === root)
    expect(created).toHaveLength(1)
    const id = created[0]?.id ?? ''
    await vi.waitFor(() => expect(output(id)).toContain('Scripted reply to: Review comments on your changes in'), slow)
    expect((await store.list())[0]?.sent?.to).toBe('Claude')
  })

  it('leaves comments unsent when the session refuses', async () => {
    const { terminals, store, root } = await setup()
    const claude = await terminals.create(root, 'claude', SIZE)
    await vi.waitFor(() => expect(stateOf(terminals, claude.id)).toBe('idle'), slow)
    terminals.write(claude.id, 'exit\r')
    await vi.waitFor(() => expect(stateOf(terminals, claude.id)).toBe('exited'), slow)
    const comment = await store.add(ANCHOR, 'Rename this')

    expect(await sendReview({ store, terminals, root, ids: [comment.id], target: { terminal: claude.id }, size: SIZE })).toEqual({ ok: false, message: "Claude isn't running" })
    expect((await store.list())[0]?.sent).toBeNull()
  })

  it('refuses when none of the ids are stored', async () => {
    const { terminals, store, root } = await setup()
    expect(await sendReview({ store, terminals, root, ids: ['rc_gone'], target: { newSession: true }, size: SIZE })).toEqual({ ok: false, message: 'Nothing to send' })
    expect(terminals.list()).toHaveLength(0)
  })
})

const prComment = (id: string, body: string): PullRequestComment => ({
  id,
  kind: 'comment',
  author: 'carol',
  body,
  url: `https://github.com/o/r/pull/7#${id}`,
  createdAt: '2026-10-20T10:00:00Z',
  path: null,
  line: null,
  side: null,
  hunk: null,
  resolved: false,
  outdated: false,
  replies: [],
  verdict: null
})

const PR: PullRequestDetail = {
  id: 'PR_1',
  number: 7,
  title: 'Add login',
  state: 'open',
  url: 'https://github.com/o/r/pull/7',
  baseRefName: 'main',
  baseRefOid: 'a'.repeat(40),
  headRefName: 'login',
  headRefOid: 'b'.repeat(40),
  author: 'alice',
  viewer: 'me',
  checks: [],
  comments: [prComment('IC_1', 'Split this PR?'), prComment('IC_2', 'Rename it'), prComment('IC_3', 'Later')],
  truncated: false
}

describe('sendPullRequestComments', () => {
  it('sends ticked PR comments behind the template and marks them sent to the agent', async () => {
    const { terminals, output, store, root } = await setup()
    const claude = await terminals.create(root, 'claude', SIZE)
    await vi.waitFor(() => expect(stateOf(terminals, claude.id)).toBe('idle'), slow)

    const result = await sendPullRequestComments({ store, terminals, root, pr: PR, ids: ['IC_2', 'IC_1'], template: 'Triage these.', target: { terminal: claude.id }, size: SIZE })
    expect(result).toEqual({ ok: true, message: 'Sent to Claude' })
    await vi.waitFor(() => expect(output(claude.id)).toContain('Scripted reply to: Triage these.'), slow)
    expect(Object.keys(await store.pullRequestSent()).sort()).toEqual(['IC_1', 'IC_2'])
    expect((await store.pullRequestSent())['IC_1']?.to).toBe('Claude')
  })

  it('refuses when none of the ids are in the PR', async () => {
    const { terminals, store, root } = await setup()
    const request = { store, terminals, root, pr: PR, ids: ['IC_9'], template: 'T', target: { newSession: true } satisfies ReviewTarget, size: SIZE }
    expect(await sendPullRequestComments(request)).toEqual({ ok: false, message: 'Nothing to send' })
    expect(terminals.list()).toHaveLength(0)
  })

  it('leaves PR comments unmarked when the session refuses', async () => {
    const { terminals, store, root } = await setup()
    const claude = await terminals.create(root, 'claude', SIZE)
    await vi.waitFor(() => expect(stateOf(terminals, claude.id)).toBe('idle'), slow)
    terminals.write(claude.id, 'exit\r')
    await vi.waitFor(() => expect(stateOf(terminals, claude.id)).toBe('exited'), slow)

    const result = await sendPullRequestComments({ store, terminals, root, pr: PR, ids: ['IC_1'], template: 'T', target: { terminal: claude.id }, size: SIZE })
    expect(result).toEqual({ ok: false, message: "Claude isn't running" })
    expect(await store.pullRequestSent()).toEqual({})
  })
})

describe('sendReviewDraft', () => {
  it('sends a comment that is not stored, and stores nothing', async () => {
    const { terminals, output, store, root } = await setup()
    const claude = await terminals.create(root, 'claude', SIZE)
    await vi.waitFor(() => expect(stateOf(terminals, claude.id)).toBe('idle'), slow)
    const result = await sendReviewDraft({ terminals, root, anchor: { ...ANCHOR, diff: 'pr:7' }, body: 'Check this', target: { terminal: claude.id }, size: SIZE })
    expect(result).toEqual({ ok: true, message: 'Sent to Claude' })
    await vi.waitFor(() => expect(output(claude.id)).toContain('Scripted reply to: Review comments on your changes in'), slow)
    expect(await store.list()).toEqual([])
  })
})
