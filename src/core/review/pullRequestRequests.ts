import type { ReviewComment, ReviewEvent } from '../../shared/ipc'

const SIDES = { old: 'LEFT', new: 'RIGHT' } satisfies Record<'old' | 'new', 'LEFT' | 'RIGHT'>

/** The body of `POST /repos/{owner}/{repo}/pulls/{n}/comments`: one line comment, posted at once. */
export function singleCommentRequest(c: { commitId: string; relPath: string; side: 'old' | 'new'; line: number; body: string }): {
  body: string
  commit_id: string
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
} {
  return { body: c.body, commit_id: c.commitId, path: c.relPath, line: c.line, side: SIDES[c.side] }
}

/** The body of `POST /repos/{owner}/{repo}/pulls/{n}/reviews`: the verdict, its summary and every pending comment. */
export function reviewRequest(r: { commitId: string; event: ReviewEvent; body: string; comments: readonly ReviewComment[] }): {
  commit_id: string
  event: ReviewEvent
  body: string
  comments: { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string }[]
} {
  return {
    commit_id: r.commitId,
    event: r.event,
    body: r.body,
    comments: r.comments.map((c) => ({ path: c.relPath, line: c.line, side: SIDES[c.side], body: c.body }))
  }
}

/** Why GitHub would refuse this review, before asking it; null when it's fine. */
export function reviewProblem(r: { event: ReviewEvent; body: string; count: number; own: boolean }): string | null {
  if (r.own && r.event !== 'COMMENT') return "You can't approve or request changes on your own PR"
  if (r.event === 'REQUEST_CHANGES' && !r.body.trim()) return 'Say what needs to change'
  if (r.event === 'COMMENT' && !r.body.trim() && r.count === 0) return 'Write a summary or add a comment'
  return null
}
