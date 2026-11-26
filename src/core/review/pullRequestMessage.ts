import type { PullRequestComment, PullRequestDetail } from '../../shared/ipc'
import { fenced } from '../threads/implementationBrief'

function block(comment: PullRequestComment, index: number): string {
  const n = `${index + 1}.`
  if (comment.kind === 'comment') return `${n} @${comment.author} commented (${comment.url})\n${comment.body}`
  if (comment.kind === 'review') return `${n} @${comment.author} reviewed, ${comment.verdict ?? 'commented'} (${comment.url})\n${comment.body}`
  const place = `${comment.path ?? ''}${comment.line === null ? '' : `:${comment.line}`}${comment.side === 'old' ? ' (old side)' : ''}${comment.outdated ? ' (outdated)' : ''}`
  const hunk = comment.hunk ? `\n${fenced(comment.hunk, 'diff')}` : ''
  const replies = comment.replies.map((reply) => `\n\n@${reply.author} replied: ${reply.body}`).join('')
  return `${n} @${comment.author} on ${place} (${comment.url})${hunk}\n${comment.body}${replies}`
}

/** The prompt an agent gets for a pull request's comments: the user's template, then each comment numbered with who wrote it and where. */
export function formatPullRequestMessage(
  template: string,
  pr: Pick<PullRequestDetail, 'number' | 'title' | 'url'>,
  comments: readonly PullRequestComment[],
  where: string
): string {
  return [template, `Comments on PR #${pr.number} "${pr.title}" (${pr.url}), for your changes in ${where}:`, ...comments.map(block)].join('\n\n')
}
