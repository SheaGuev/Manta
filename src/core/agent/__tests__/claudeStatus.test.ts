import { describe, expect, it } from 'vitest'
import { claudeCodeStatus, parseAuthStatus, parseVersion } from '../claudeStatus'

describe('Claude Code status parsing', () => {
  it('reads the version and the auth status JSON', () => {
    expect(parseVersion('2.1.285 (Claude Code)\n')).toBe('2.1.285')
    expect(parseVersion('nothing here')).toBeNull()
    expect(parseAuthStatus({ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock', configDirectory: '/x' })).toEqual({
      loggedIn: true,
      authMethod: 'third_party',
      apiProvider: 'bedrock'
    })
    expect(parseAuthStatus({ loggedIn: 'yes' })).toEqual({ loggedIn: false, authMethod: null, apiProvider: null })
    expect(parseAuthStatus(null)).toEqual({ loggedIn: false, authMethod: null, apiProvider: null })
  })

  it('reports a missing install without running anything, and a broken one as an error', async () => {
    expect(await claudeCodeStatus(null)).toMatchObject({ path: null, loggedIn: false, error: null })
    expect(await claudeCodeStatus('/nonexistent/claude')).toMatchObject({ path: '/nonexistent/claude', loggedIn: false, error: expect.any(String) })
  })
})
