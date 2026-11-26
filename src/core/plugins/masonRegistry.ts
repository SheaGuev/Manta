/** One package in Mason's registry: what it is, where it comes from, and the commands it installs. */
export interface MasonPackage {
  name: string
  description: string
  homepage: string
  languages: string[]
  categories: string[]
  /** A purl: `pkg:npm/pyright@1.1.414`, `pkg:github/astral-sh/ruff@0.17.2`, `pkg:generic/hashicorp/terraform-ls@v0.39.0`. */
  sourceId: string
  /** Release assets per platform (`pkg:github`). */
  assets: MasonTarget[]
  /** Downloads per platform (`pkg:generic`). */
  downloads: MasonTarget[]
  /** More npm or PyPI packages installed alongside. */
  extraPackages: string[]
  /** Command name → where it is: `npm:pyright-langserver`, `pypi:ruff`, `{{source.asset.bin}}`, a path. */
  bin: Record<string, string>
}

/** A platform's asset or downloads: `file` for a GitHub asset, `files` (local name → URL) for a download. */
export interface MasonTarget {
  targets: string[]
  file: string | null
  files: Record<string, string>
  bin: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function parseTargets(value: unknown): MasonTarget[] {
  /** A package with one target writes it as an object rather than a list. */
  const list = Array.isArray(value) ? value : isRecord(value) ? [value] : []
  return list.filter(isRecord).map((entry) => ({
    targets: typeof entry.target === 'string' ? [entry.target] : strings(entry.target),
    file: typeof entry.file === 'string' ? entry.file : null,
    files: isRecord(entry.files) ? Object.fromEntries(Object.entries(entry.files).filter((e): e is [string, string] => typeof e[1] === 'string')) : {},
    bin: typeof entry.bin === 'string' ? entry.bin : null
  }))
}

/** Mason's `registry.json`; entries without a name or source are dropped. */
export function parseRegistry(json: unknown): MasonPackage[] {
  if (!Array.isArray(json)) throw new Error('Mason registry is not a list of packages')
  return json.filter(isRecord).flatMap((entry) => {
    const source = isRecord(entry.source) ? entry.source : null
    if (typeof entry.name !== 'string' || !source || typeof source.id !== 'string') return []
    return [
      {
        name: entry.name,
        description: text(entry.description).trim(),
        homepage: text(entry.homepage),
        languages: strings(entry.languages),
        categories: strings(entry.categories),
        sourceId: source.id,
        assets: parseTargets(source.asset),
        downloads: parseTargets(source.download),
        extraPackages: strings(source.extra_packages),
        bin: isRecord(entry.bin) ? Object.fromEntries(Object.entries(entry.bin).filter((e): e is [string, string] => typeof e[1] === 'string')) : {}
      }
    ]
  })
}

export interface Purl {
  type: string
  /** `astral-sh` in `pkg:github/astral-sh/ruff`, `@biomejs` in `pkg:npm/%40biomejs/biome`; empty without one. */
  namespace: string
  name: string
  version: string
  qualifiers: Record<string, string>
}

/** Parses a package URL as Mason writes them; null for anything else. */
export function parsePurl(id: string): Purl | null {
  const match = /^pkg:([a-z]+)\/([^?]+?)@([^?@]+)(?:\?(.*))?$/.exec(id)
  if (!match?.[1] || !match[2] || !match[3]) return null
  const segments = match[2].split('/').map(decodeURIComponent)
  const name = segments.pop() ?? ''
  const qualifiers = Object.fromEntries(new URLSearchParams(match[4] ?? ''))
  return { type: match[1], namespace: segments.join('/'), name, version: decodeURIComponent(match[3]), qualifiers }
}

/** Mason's names for this machine, most specific first. */
export function platformTargets(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string[] {
  const os = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win' : 'linux'
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : arch
  const names = [`${os}_${cpu}`, os]
  if (os === 'linux') names.unshift(`linux_${cpu}_gnu`)
  if (os !== 'win') names.push('unix')
  return names
}

/** The target entry for this machine: the first whose targets include the most specific name. */
export function targetFor(entries: MasonTarget[], targets: string[]): MasonTarget | null {
  for (const name of targets) {
    const found = entries.find((entry) => entry.targets.includes(name))
    if (found) return found
  }
  return null
}

type TemplateValue = string | { [key: string]: TemplateValue }

/**
 * Mason's `{{ path | filter "arg" }}` expressions, for the filters its packages use: `strip_prefix`
 * and `strip_suffix`. Throws for an unknown path or filter rather than install from a wrong URL.
 */
export function renderTemplate(template: string, context: Record<string, TemplateValue>): string {
  return template.replace(/{{\s*([^}]+?)\s*}}/g, (_whole, expression: string) => {
    const [path = '', ...filters] = expression.split('|').map((part) => part.trim())
    let value: TemplateValue | undefined = context
    for (const key of path.split('.')) value = typeof value === 'object' ? value[key] : undefined
    if (typeof value !== 'string') throw new Error(`Unknown template value ${path}`)
    for (const filter of filters) {
      const [name, rawArg = ''] = filter.split(/\s+(.+)/)
      const arg = rawArg.replace(/^"(.*)"$/, '$1')
      if (name === 'strip_prefix') value = value.startsWith(arg) ? value.slice(arg.length) : value
      else if (name === 'strip_suffix') value = value.endsWith(arg) ? value.slice(0, -arg.length) : value
      else throw new Error(`Unsupported template filter ${name}`)
    }
    return value
  })
}

/** Where an installed command is, relative to the package's install folder. */
export type BinRef = { kind: 'npm' | 'pypi' | 'cargo' | 'golang'; name: string } | { kind: 'path'; path: string }

/** A file to download, the name to save it as, and where in the install folder to unpack it. */
export interface Download {
  url: string
  name: string
  /** A folder inside the install folder; empty for its root. */
  into: string
}

export type InstallPlan =
  | { kind: 'npm'; packages: string[]; bins: Record<string, BinRef> }
  | { kind: 'pypi'; packages: string[]; bins: Record<string, BinRef> }
  | { kind: 'download'; downloads: Download[]; bins: Record<string, BinRef> }
  | { kind: 'cargo'; crate: string; version: string; git: string | null; bins: Record<string, BinRef> }
  | { kind: 'golang'; module: string; version: string; bins: Record<string, BinRef> }

function binRef(spec: string, context: Record<string, TemplateValue>): BinRef {
  const rendered = renderTemplate(spec, context)
  const prefixed = /^(npm|pypi|cargo|golang):(.+)$/.exec(rendered)
  const kind = prefixed?.[1]
  if (prefixed?.[2] && (kind === 'npm' || kind === 'pypi' || kind === 'cargo' || kind === 'golang')) return { kind, name: prefixed[2] }
  /** `exec:` wrappers and other launchers aren't supported; the bin is used as a path. */
  return { kind: 'path', path: rendered.replace(/^exec:/, '') }
}

function targetContext(target: MasonTarget, version: string): Record<string, TemplateValue> {
  const fields: Record<string, TemplateValue> = {}
  if (target.file) fields.file = renderTemplate(target.file, { version })
  if (target.bin) fields.bin = renderTemplate(target.bin, { version })
  return fields
}

/** How to install a package on this machine, or why it can't be. */
export function installPlan(pkg: MasonPackage, targets: string[] = platformTargets()): InstallPlan | { unsupported: string } {
  const purl = parsePurl(pkg.sourceId)
  if (!purl) return { unsupported: `Can't read the package source ${pkg.sourceId}` }
  const { version } = purl
  const full = purl.namespace ? `${purl.namespace}/${purl.name}` : purl.name
  const bins = (context: Record<string, TemplateValue>): Record<string, BinRef> =>
    Object.fromEntries(Object.entries(pkg.bin).map(([command, spec]) => [command, binRef(spec, context)]))
  try {
    switch (purl.type) {
      case 'npm':
        return { kind: 'npm', packages: [`${full}@${version}`, ...pkg.extraPackages], bins: bins({ version }) }
      case 'pypi':
        return { kind: 'pypi', packages: [`${full}==${version}`, ...pkg.extraPackages], bins: bins({ version }) }
      case 'github': {
        const asset = targetFor(pkg.assets, targets)
        if (!asset?.file) return { unsupported: `${pkg.name} has no release for this machine` }
        const fields = targetContext(asset, version)
        const [file = '', into = ''] = String(fields.file).split(':')
        const url = `https://github.com/${full}/releases/download/${version}/${file}`
        return { kind: 'download', downloads: [{ url, name: file.split('/').pop() ?? file, into }], bins: bins({ version, source: { asset: fields } }) }
      }
      case 'generic': {
        const download = targetFor(pkg.downloads, targets)
        if (!download) return { unsupported: `${pkg.name} has no download for this machine` }
        const downloads = Object.entries(download.files).map(([name, url]) => {
          const [file = name, into = ''] = name.split(':')
          return { url: renderTemplate(url, { version }), name: file, into }
        })
        return { kind: 'download', downloads, bins: bins({ version, source: { download: targetContext(download, version) } }) }
      }
      case 'cargo':
        return { kind: 'cargo', crate: purl.name, version, git: purl.qualifiers.repository_url ?? null, bins: bins({ version }) }
      case 'golang':
        return { kind: 'golang', module: full, version, bins: bins({ version }) }
      default:
        return { unsupported: `Installing ${purl.type} packages isn't supported yet` }
    }
  } catch (error) {
    return { unsupported: error instanceof Error ? error.message : String(error) }
  }
}
