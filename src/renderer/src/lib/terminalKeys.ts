import type { TerminalKind } from '../../../shared/ipc'

/** The fields of a key event `editKey` reads. */
export type KeyFields = Pick<KeyboardEvent, 'type' | 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

type Modifier = 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'

function only(event: KeyFields, modifier: Modifier): boolean {
  const modifiers: Modifier[] = ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']
  return modifiers.every((name) => event[name] === (name === modifier))
}

/**
 * What a terminal should send for an editing shortcut instead of xterm's own encoding, or null to
 * leave the key to xterm.
 *
 * - Option+Delete is Ctrl+W, as in VS Code's terminal: xterm's `ESC DEL` reads as "delete word" only to
 *   emacs-style line editors, while zsh in vi mode (picked when `$EDITOR` is vi) takes it as Escape then
 *   a cursor move, and leaves insert mode.
 * - Cmd+Delete is Ctrl+U, deleting back to the start of the line; xterm ignores Cmd and sends one DEL.
 * - Shift+Enter in a Claude session is Ctrl+J, which Claude Code reads as a newline; xterm sends CR,
 *   which submits. Shells keep CR, since zsh takes Ctrl+J as accept-line anyway.
 */
export function editKey(event: KeyFields, kind: TerminalKind): string | null {
  if (event.type !== 'keydown') return null
  if (event.key === 'Backspace') {
    if (only(event, 'altKey')) return '\x17'
    if (only(event, 'metaKey')) return '\x15'
  }
  if (event.key === 'Enter' && kind === 'claude' && only(event, 'shiftKey')) return '\n'
  return null
}
