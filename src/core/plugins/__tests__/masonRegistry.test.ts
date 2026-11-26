import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { installPlan, parsePurl, parseRegistry, platformTargets, renderTemplate, type MasonPackage } from '../masonRegistry'

/** Real entries from Mason's registry (October 2026), one of each source kind. */
const registry = parseRegistry(JSON.parse(readFileSync(path.join(__dirname, 'fixtures/mason-packages.json'), 'utf8')))
const pkg = (name: string): MasonPackage => {
  const found = registry.find((p) => p.name === name)
  if (!found) throw new Error(`no ${name} in the fixture`)
  return found
}
const MAC_ARM = platformTargets('darwin', 'arm64')

describe('parsePurl', () => {
  it('reads type, namespace, name and version', () => {
    expect(parsePurl('pkg:github/astral-sh/ruff@0.17.2')).toEqual({ type: 'github', namespace: 'astral-sh', name: 'ruff', version: '0.17.2', qualifiers: {} })
  })

  it('reads scoped npm packages, encoded or not', () => {
    expect(parsePurl('pkg:npm/%40biomejs/biome@2.6.2')).toMatchObject({ namespace: '@biomejs', name: 'biome', version: '2.6.2' })
    expect(parsePurl('pkg:npm/@biomejs/biome@2.6.2')).toMatchObject({ namespace: '@biomejs', name: 'biome', version: '2.6.2' })
  })

  it('keeps a version that contains a slash, and reads qualifiers', () => {
    expect(parsePurl('pkg:generic/Kotlin/kotlin-lsp@kotlin-lsp/v263.7084.0')?.version).toBe('kotlin-lsp/v263.7084.0')
    expect(parsePurl('pkg:cargo/thing@1.0.0?repository_url=https://github.com/x/thing')?.qualifiers).toEqual({ repository_url: 'https://github.com/x/thing' })
  })

  it('is null for something that is not a purl', () => {
    expect(parsePurl('npm:pyright')).toBeNull()
    expect(parsePurl('pkg:npm/no-version')).toBeNull()
  })
})

describe('renderTemplate', () => {
  it('fills values and applies strip_prefix and strip_suffix', () => {
    expect(renderTemplate('v={{ version | strip_prefix "v" }} f={{source.asset.file}}', { version: 'v1.2', source: { asset: { file: 'a.zip' } } })).toBe('v=1.2 f=a.zip')
    expect(renderTemplate('{{ version | strip_suffix ".0" }}', { version: '3.0' })).toBe('3')
  })

  it('throws for an unknown value or filter, rather than build a wrong URL', () => {
    expect(() => renderTemplate('{{ nope }}', {})).toThrow('Unknown template value nope')
    expect(() => renderTemplate('{{ version | to_upper }}', { version: '1' })).toThrow('Unsupported template filter to_upper')
  })
})

describe('platformTargets', () => {
  it('names the platform most specific first', () => {
    expect(MAC_ARM).toEqual(['darwin_arm64', 'darwin', 'unix'])
    expect(platformTargets('linux', 'x64')).toEqual(['linux_x64_gnu', 'linux_x64', 'linux', 'unix'])
  })
})

describe('installPlan', () => {
  it('installs npm packages with their version, and finds their commands in node_modules/.bin', () => {
    expect(installPlan(pkg('pyright'), MAC_ARM)).toEqual({
      kind: 'npm',
      packages: ['pyright@1.1.414'],
      bins: { pyright: { kind: 'npm', name: 'pyright' }, 'pyright-langserver': { kind: 'npm', name: 'pyright-langserver' } }
    })
    expect(installPlan(pkg('biome'), MAC_ARM)).toMatchObject({ kind: 'npm', packages: ['@biomejs/biome@2.6.2'] })
  })

  it('installs PyPI packages pinned to their version', () => {
    expect(installPlan(pkg('basedpyright'), MAC_ARM)).toMatchObject({ kind: 'pypi', packages: ['basedpyright==1.40.2'], bins: { basedpyright: { kind: 'pypi', name: 'basedpyright' } } })
  })

  it('downloads this machine\'s GitHub release asset, with the bin path inside it', () => {
    expect(installPlan(pkg('ruff'), MAC_ARM)).toEqual({
      kind: 'download',
      downloads: [{ url: 'https://github.com/astral-sh/ruff/releases/download/0.17.2/ruff-aarch64-apple-darwin.tar.gz', name: 'ruff-aarch64-apple-darwin.tar.gz', into: '' }],
      bins: { ruff: { kind: 'path', path: 'ruff-aarch64-apple-darwin/ruff' } }
    })
  })

  it('downloads a single-file asset as the command itself', () => {
    expect(installPlan(pkg('buf'), MAC_ARM)).toMatchObject({
      downloads: [{ url: 'https://github.com/bufbuild/buf/releases/download/v1.75.0/buf-Darwin-arm64', name: 'buf-Darwin-arm64' }],
      bins: { buf: { kind: 'path', path: 'buf-Darwin-arm64' } }
    })
  })

  it('renders generic download URLs, stripping the version\'s prefix as the package says', () => {
    expect(installPlan(pkg('terraform-ls'), MAC_ARM)).toEqual({
      kind: 'download',
      downloads: [{ url: 'https://releases.hashicorp.com/terraform-ls/0.39.0/terraform-ls_0.39.0_darwin_arm64.zip', name: 'terraform-ls.zip', into: '' }],
      bins: { 'terraform-ls': { kind: 'path', path: 'terraform-ls' } }
    })
    expect(installPlan(pkg('kotlin-lsp'), MAC_ARM)).toMatchObject({ bins: { 'intellij-server': { kind: 'path', path: 'kotlin-server-263.7084.0/bin/intellij-server' } } })
  })

  it('installs Go modules with go install', () => {
    expect(installPlan(pkg('gopls'), MAC_ARM)).toMatchObject({ kind: 'golang', module: 'golang.org/x/tools/gopls', version: 'v0.23.0' })
  })

  it('says why when there is no build for the machine or the source kind is unknown', () => {
    expect(installPlan(pkg('ruff'), ['plan9_mips'])).toEqual({ unsupported: 'ruff has no release for this machine' })
    const gem = { ...pkg('pyright'), sourceId: 'pkg:gem/solargraph@0.50.0' }
    expect(installPlan(gem, MAC_ARM)).toEqual({ unsupported: "Installing gem packages isn't supported yet" })
  })
})

describe('parseRegistry', () => {
  it('drops entries without a name or source, and refuses a registry that is not a list', () => {
    expect(parseRegistry([{ name: 'x' }, { source: { id: 'pkg:npm/y@1' } }, null])).toEqual([])
    expect(() => parseRegistry({})).toThrow('not a list')
  })
})
