import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { ThreadFork, ThreadForkStore } from '../threadForks'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc()
  doc.getText('md').insert(0, text)
  return doc
}

describe('ThreadFork', () => {
  it('edits a copy and merges into a doc that changed meanwhile', () => {
    const doc = docWith('Sessions last 30 days.\n\nLogin uses magic links.\n')
    const fork = ThreadFork.from(doc)

    fork.replace('30 days', '14 days')
    doc.getText('md').insert(doc.getText('md').toString().indexOf('magic'), 'passwordless ')
    Y.applyUpdate(doc, fork.updateFor(doc))

    expect(doc.getText('md').toString()).toBe('Sessions last 14 days.\n\nLogin uses passwordless magic links.\n')
    expect(fork.baseText()).toBe('Sessions last 30 days.\n\nLogin uses magic links.\n')
    expect(fork.hasChanges()).toBe(true)
  })

  it('refuses a replace whose text is missing, empty or ambiguous', () => {
    const fork = ThreadFork.from(docWith('None yet.\n\nNone yet.\n'))
    expect(() => fork.replace('Nothing', 'x')).toThrow('not found')
    expect(() => fork.replace('', 'x')).toThrow('empty')
    expect(() => fork.replace('None yet.', 'x')).toThrow('more than once')
    expect(fork.hasChanges()).toBe(false)
  })

  it('round-trips through the store, keeping the fork point', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'manta-forks-'))
    dirs.push(dir)
    const store = new ThreadForkStore(dir)
    const fork = ThreadFork.from(docWith('# Plan\n\nDraft.\n'))
    fork.replace('Draft.', 'Final.')
    await store.save('t_1', fork)

    const loaded = await store.load('t_1')

    expect(loaded?.baseText()).toBe('# Plan\n\nDraft.\n')
    expect(loaded?.text.toString()).toBe('# Plan\n\nFinal.\n')
    expect(await store.load('t_missing')).toBeNull()
  })
})
