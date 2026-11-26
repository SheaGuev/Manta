import type { ThreadMessage } from '../../shared/ipc'

export interface BriefContext {
  threadId: string
  title: string
  /** The doc's path inside the docs repo. */
  doc: string
  docsRoot: string
  section: string
  /** The doc thread the implementation was started from, if any. */
  source: { title: string; messages: readonly ThreadMessage[] } | null
}

/**
 * What an implementation session is told about its work, appended to Claude Code's system prompt
 * (`--append-system-prompt-file`). Rebuilt on every start, so a resumed session sees the section as it is now.
 */
export function implementationBrief(context: BriefContext): string {
  const lines = [
    '# Manta implementation brief',
    '',
    `You were started from Manta to implement a section of a doc, "${context.title}" (Manta thread ${context.threadId}).`,
    '',
    `- The doc is \`${context.doc}\` in the docs repo at \`${context.docsRoot}\`. Read it, and docs near it, for context.`,
    `- End every commit message with the trailer \`Manta-Thread: ${context.threadId}\`, so Manta can tell when the work has landed.`,
    '',
    '## Changing the doc',
    '',
    '- The docs repo is read-only for you: never edit, create or delete files in it. Doc changes go through the `propose_doc_change` tool; each call becomes a Manta thread the user reviews.',
    '- Docs stay high-level. Propose a change only when what you built shows the doc is wrong, is missing a significant piece of architecture, or lacks a decision or fix that turned out to be needed and was not foreseen.',
    "- Match the doc's level of detail. Write the decision and why it was made, never code: no function names, file paths, signatures or step-by-step implementation, unless the doc already works at that level.",
    '- Do not propose changes for what the doc leaves open on purpose, for wording, or for details a reader of the code can see for themselves.',
    '- Put related points about one section into a single proposal. If you change your mind about one that is still open, use `revise_doc_change` or `withdraw_doc_change` with the id it returned rather than proposing it again.',
    '- Mention what you proposed in your reply.',
    '',
    '## The section',
    '',
    fenced(context.section)
  ]
  if (context.source) {
    const messages = context.source.messages.flatMap((message) =>
      message.role === 'user' ? [`**User:** ${message.text}`] : message.role === 'assistant' ? [`**Agent:** ${message.text}`] : []
    )
    lines.push('', `## The thread it came from: "${context.source.title}"`, '', ...(messages.length > 0 ? messages.join('\n\n').split('\n') : ['No messages.']))
  }
  return `${lines.join('\n')}\n`
}

/** A fence longer than any backtick run inside, so a section holding code blocks stays one block. */
export function fenced(text: string, language = 'markdown'): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${text}\n${fence}`
}
