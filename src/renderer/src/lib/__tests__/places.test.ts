import { describe, expect, it } from 'vitest'
import type { Project } from '../../../../shared/ipc'
import { contextExists, inProject, type PlaceContext } from '../places'

const docs: Project = { root: '/docs', name: 'docs', kind: 'docs' }
const app: Project = { root: '/code/app', name: 'app', kind: 'code' }
const api: Project = { root: '/code/api', name: 'api', kind: 'code' }
const worktree: PlaceContext = { root: '/data/worktrees/app-1a2b/feature', kind: 'worktree', project: '/code/app' }

describe('contextExists', () => {
  const known = { projects: [docs, app, api], docsRoot: '/docs', maps: ['m_1'] }

  it('keeps a worktree only while its own project is registered', () => {
    expect(contextExists(worktree, known)).toBe(true)
    expect(contextExists(worktree, { ...known, projects: [docs, api] })).toBe(false)
  })

  it('accepts a worktree saved before contexts named their project while any code project exists', () => {
    const legacy: PlaceContext = { root: worktree.root, kind: 'worktree' }
    expect(contextExists(legacy, known)).toBe(true)
    expect(contextExists(legacy, { ...known, projects: [docs] })).toBe(false)
  })

  it('keeps a map only while it exists in the current docs repo', () => {
    expect(contextExists({ root: '/docs', kind: 'map', map: 'm_1' }, known)).toBe(true)
    expect(contextExists({ root: '/docs', kind: 'map', map: 'm_2' }, known)).toBe(false)
    expect(contextExists({ root: '/old-docs', kind: 'map', map: 'm_1' }, known)).toBe(false)
    expect(contextExists({ root: '/docs', kind: 'map', map: 'm_1' }, { ...known, maps: null })).toBe(false)
  })

  it('keeps a project root only while it is registered', () => {
    expect(contextExists({ root: '/docs', kind: 'docs' }, known)).toBe(true)
    expect(contextExists({ root: '/gone', kind: 'docs' }, known)).toBe(false)
  })
})

describe('inProject', () => {
  it('matches the project itself, its worktrees and folders inside it, but not a sibling with a longer name', () => {
    expect(inProject({ root: '/code/app', kind: 'docs' }, '/code/app')).toBe(true)
    expect(inProject(worktree, '/code/app')).toBe(true)
    expect(inProject({ root: '/code/app/sub', kind: 'worktree' }, '/code/app')).toBe(true)
    expect(inProject({ root: '/code/app2', kind: 'docs' }, '/code/app')).toBe(false)
    expect(inProject({ ...worktree, project: '/code/api' }, '/code/app')).toBe(false)
  })
})
