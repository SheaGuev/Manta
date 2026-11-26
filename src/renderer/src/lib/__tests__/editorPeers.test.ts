import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { joinPeers } from '../editorPeers'

describe('editor peers', () => {
  it('passes one editor’s updates to the others on the same file, and stops once one leaves', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    const other = new Y.Doc()
    const peerA = joinPeers('root\0doc.md', (update) => Y.applyUpdate(a, update, 'main'))
    const peerB = joinPeers('root\0doc.md', (update) => Y.applyUpdate(b, update, 'main'))
    const peerOther = joinPeers('root\0other.md', (update) => Y.applyUpdate(other, update, 'main'))
    a.on('update', (update: Uint8Array, origin: unknown) => origin !== 'main' && peerA.share(update))

    a.getText('md').insert(0, 'Hello')
    expect(b.getText('md').toString()).toBe('Hello')
    expect(other.getText('md').toString()).toBe('')

    peerB.leave()
    a.getText('md').insert(5, ' world')
    expect(b.getText('md').toString()).toBe('Hello')
    peerA.leave()
    peerOther.leave()
  })
})
