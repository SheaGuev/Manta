import type { ReviewComment } from '../../shared/ipc'
import { fenced } from '../threads/implementationBrief'

/** The prompt an agent gets for a batch of review comments: no template, just where each one is and what it says. */
export function formatReviewMessage(comments: readonly ReviewComment[], where: string): string {
  const blocks = comments.map((comment, index) => {
    const place = `${comment.relPath}:${comment.line}${comment.side === 'old' ? ' (old side, removed line)' : ''}`
    return `${index + 1}. ${place}\n${fenced(comment.hunk, 'diff')}\n${comment.body}`
  })
  return [`Review comments on your changes in ${where}:`, ...blocks].join('\n\n')
}
