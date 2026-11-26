import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PR_TEMPLATE, ReviewSettings } from '../reviewSettings'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'manta-review-settings-'))
  file = path.join(dir, 'review-settings.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ReviewSettings', () => {
  it('starts unconfirmed with the default template', async () => {
    expect(DEFAULT_PR_TEMPLATE).toBe(
      'Analyse these PR comments, assign a reference to each like C1, C2, C3… Create a table with what can be addressed with your recommendations, split actionable items from items which require more thought.'
    )
    expect(await new ReviewSettings(file).template()).toEqual({ text: DEFAULT_PR_TEMPLATE, confirmed: false })
  })

  it('saves a template as confirmed and keeps it across a reopen', async () => {
    await new ReviewSettings(file).setTemplate('  Fix what you can.  ')
    expect(await new ReviewSettings(file).template()).toEqual({ text: 'Fix what you can.', confirmed: true })
    await expect(new ReviewSettings(file).setTemplate('   ')).rejects.toThrow()
  })

  it('reads a corrupt file as the unconfirmed default', async () => {
    await writeFile(file, '{not json')
    expect(await new ReviewSettings(file).template()).toEqual({ text: DEFAULT_PR_TEMPLATE, confirmed: false })
    await writeFile(file, '{"prTemplate": 3}')
    expect(await new ReviewSettings(file).template()).toEqual({ text: DEFAULT_PR_TEMPLATE, confirmed: false })
  })
})
