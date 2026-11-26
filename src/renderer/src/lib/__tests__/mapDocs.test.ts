import { describe, expect, it } from 'vitest'
import type { MapDocInfo, MapMilestoneInfo, MapTicket } from '../../../../shared/ipc'
import { citingTickets, docCoverage, docMatches, headingLine, headingSlug, plainHeading, roleFilters, sectionLink, splitDoc } from '../mapDocs'

function doc(path: string, extra: Partial<MapDocInfo> = {}): MapDocInfo {
  return { path, milestones: [], section: null, roles: [], exists: true, title: path, updatedAt: null, ...extra }
}

describe('splitDoc', () => {
  it('drops the title, keeps the intro, and splits at ## headings outside code fences', () => {
    const text = ['# Runbook', '', 'Configure production.', '', '## 1. Infrastructure', 'Fly · omni-prod', '```sh', '## not a heading', '```', '### Detail', 'More.', '## Verify ##', 'Run acceptance.'].join('\n')
    expect(splitDoc(text)).toEqual({
      intro: 'Configure production.',
      sections: [
        { heading: '1. Infrastructure', body: 'Fly · omni-prod\n```sh\n## not a heading\n```\n### Detail\nMore.' },
        { heading: 'Verify', body: 'Run acceptance.' }
      ]
    })
  })

  it('drops YAML frontmatter', () => {
    expect(splitDoc('---\nupdated: 2026-11-21\ntags: [omni]\n---\n# Runbook\nIntro.\n## A\nBody')).toEqual({ intro: 'Intro.', sections: [{ heading: 'A', body: 'Body' }] })
  })

  it('keeps a second # heading as text', () => {
    expect(splitDoc('# A\n# B\ntext')).toEqual({ intro: '# B\ntext', sections: [] })
  })
})

describe('section links', () => {
  it('anchors like GitHub', () => {
    expect(headingSlug('1. Production infrastructure')).toBe('1-production-infrastructure')
    expect(plainHeading('2. Fly (`omni-prod`) and **R2**')).toBe('2. Fly (omni-prod) and R2')
    expect(sectionLink('docs/run.md', 'Verify before release')).toBe('[Verify before release](docs/run.md#verify-before-release)')
  })
})

describe('the docs list', () => {
  it('covers a line once the docs carry all its roles, together or apart', () => {
    const docs = [doc('a.md', { roles: ['product'] }), doc('b.md', { roles: ['technical', 'release'] })]
    expect(docCoverage(docs).map((l) => [l.label, l.covered])).toEqual([
      ['Product & technical plan', true],
      ['Release guidance', true],
      ['Design reference', false]
    ])
    expect(docCoverage([doc('a.md', { roles: ['product'] })])[0]?.covered).toBe(false)
  })

  it('offers filters for the roles present, and searches title, path and link address', () => {
    const link = doc('link:1', { title: 'Login flow', link: { url: 'https://figma.com/file/x', title: 'Login flow' }, roles: ['design'] })
    expect(roleFilters([doc('a.md', { roles: ['release', 'product'] }), link])).toEqual(['product', 'design', 'release'])
    expect(docMatches(link, 'FIGMA')).toBe(true)
    expect(docMatches(link, 'runbook')).toBe(false)
    expect(docMatches(link, '  ')).toBe(true)
  })

  it('finds the tickets citing a doc, whole or a section', () => {
    const t = (id: string, path: string, heading: string | null): MapTicket => ({ id, number: 1, title: id, description: '', acceptance: [], constraints: [], after: [], docs: [{ path, heading }], project: null, status: 'todo', blocked: null, cancelled: null })
    const milestones: MapMilestoneInfo[] = [{ id: 'ms_1', title: 'M', description: '', doneWhen: [], tickets: [t('a', 'run.md', null), t('b', 'run.md', 'Verify'), t('c', 'other.md', null)], landed: false, manual: null, status: 'todo' }]
    expect(citingTickets({ milestones }, 'run.md').map((x) => x.id)).toEqual(['a', 'b'])
  })
})

describe('heading line', () => {
  it('finds the nth section heading, skipping fenced code, and falls back to any line with that heading', () => {
    const text = ['# Title', '', '## Setup', '```', '## not a heading', '```', '## Verify', 'text', '## Setup'].join('\n')
    expect(headingLine(text, 'Setup', 0)).toBe(3)
    expect(headingLine(text, 'Verify', 1)).toBe(7)
    expect(headingLine(text, 'Setup', 2)).toBe(9)
    expect(headingLine(text, 'Setup', 5)).toBe(3)
    expect(headingLine(text, 'Gone', 0)).toBeNull()
  })
})
