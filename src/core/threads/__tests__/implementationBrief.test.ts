import { describe, expect, it } from 'vitest'
import { implementationBrief } from '../implementationBrief'

const BASE = { threadId: 't_abc', title: 'Magic links', doc: 'auth.md', docsRoot: '/docs', section: '## Login\n\nMagic links.', source: null }

describe('implementationBrief', () => {
  it('names the doc, the read-only docs repo, the trailer, and quotes the section', () => {
    const brief = implementationBrief(BASE)
    expect(brief).toContain('`auth.md` in the docs repo at `/docs`')
    expect(brief).toContain('read-only')
    expect(brief).toContain('`propose_doc_change`')
    expect(brief).toContain('`withdraw_doc_change`')
    expect(brief).toContain('`Manta-Thread: t_abc`')
    expect(brief).toContain('```markdown\n## Login\n\nMagic links.\n```')
    expect(brief).not.toContain('thread it came from')
  })

  it("keeps proposals at the doc's level of detail", () => {
    const brief = implementationBrief(BASE)
    expect(brief).toContain('## Changing the doc')
    expect(brief).toContain("Match the doc's level of detail")
    expect(brief).toContain('never code')
    expect(brief).toContain('single proposal')
  })

  it("fences a section holding code blocks with a longer fence", () => {
    const brief = implementationBrief({ ...BASE, section: '## Login\n\n```ts\nlogin()\n```' })
    expect(brief).toContain('````markdown\n## Login\n\n```ts\nlogin()\n```\n````')
  })

  it("adds the source thread's conversation, without tool and status lines", () => {
    const brief = implementationBrief({
      ...BASE,
      source: {
        title: 'Login design',
        messages: [
          { role: 'user', text: 'Use magic links?', at: '' },
          { role: 'tool', text: 'Read auth.md', at: '' },
          { role: 'assistant', text: 'Yes, with a 15 minute expiry.', at: '' },
          { role: 'status', text: 'Cancelled', at: '' }
        ]
      }
    })
    expect(brief).toContain('## The thread it came from: "Login design"')
    expect(brief).toContain('**User:** Use magic links?\n\n**Agent:** Yes, with a 15 minute expiry.')
    expect(brief).not.toContain('Read auth.md')
    expect(brief).not.toContain('Cancelled')
  })
})
