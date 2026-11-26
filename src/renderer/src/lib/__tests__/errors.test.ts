import { describe, expect, it } from 'vitest'
import { withoutIpcPrefix } from '../errors'

describe('withoutIpcPrefix', () => {
  it("strips Electron's IPC prefix", () => {
    expect(withoutIpcPrefix("Error invoking remote method 'repo:create-file': Error: src/auth.ts already exists")).toBe(
      'src/auth.ts already exists'
    )
  })

  it('strips the prefix when the original error was a subclass', () => {
    expect(withoutIpcPrefix("Error invoking remote method 'repo:pull': GitError: git pull failed")).toBe('git pull failed')
  })

  it('leaves other messages alone', () => {
    expect(withoutIpcPrefix('Pull failed: Error: offline')).toBe('Pull failed: Error: offline')
    expect(withoutIpcPrefix('')).toBe('')
  })
})
