import { describe, expect, it } from 'vitest'
import { editKey } from '../terminalKeys'

const key = (fields: Partial<Pick<KeyboardEvent, 'type' | 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>>) => ({
  type: 'keydown',
  key: 'Backspace',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...fields
})

describe('editKey', () => {
  it('sends Ctrl+W for Option+Delete, which deletes a word in emacs and vi insert modes alike', () => {
    expect(editKey(key({ altKey: true }), 'shell')).toBe('\x17')
    expect(editKey(key({ altKey: true }), 'claude')).toBe('\x17')
  })

  it('sends Ctrl+U for Cmd+Delete, which deletes to the start of the line', () => {
    expect(editKey(key({ metaKey: true }), 'shell')).toBe('\x15')
    expect(editKey(key({ metaKey: true }), 'claude')).toBe('\x15')
  })

  it('sends Ctrl+J for Shift+Enter in a Claude session, which Claude Code reads as a newline', () => {
    expect(editKey(key({ key: 'Enter', shiftKey: true }), 'claude')).toBe('\n')
  })

  it('leaves Shift+Enter in a shell to xterm', () => {
    expect(editKey(key({ key: 'Enter', shiftKey: true }), 'shell')).toBeNull()
  })

  it('leaves every other key to xterm', () => {
    expect(editKey(key({}), 'claude')).toBeNull()
    expect(editKey(key({ altKey: true, shiftKey: true }), 'claude')).toBeNull()
    expect(editKey(key({ altKey: true, metaKey: true }), 'claude')).toBeNull()
    expect(editKey(key({ altKey: true, ctrlKey: true }), 'claude')).toBeNull()
    expect(editKey(key({ metaKey: true, shiftKey: true }), 'claude')).toBeNull()
    expect(editKey(key({ altKey: true, key: 'b' }), 'claude')).toBeNull()
    expect(editKey(key({ altKey: true, type: 'keyup' }), 'claude')).toBeNull()
    expect(editKey(key({ key: 'Enter' }), 'claude')).toBeNull()
    expect(editKey(key({ key: 'Enter', shiftKey: true, metaKey: true }), 'claude')).toBeNull()
    expect(editKey(key({ key: 'Enter', shiftKey: true, type: 'keyup' }), 'claude')).toBeNull()
  })
})
