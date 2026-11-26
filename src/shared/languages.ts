const LANGUAGE_IDS: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascriptreact',
  py: 'python',
  pyi: 'python',
  json: 'json',
  jsonc: 'jsonc',
  yaml: 'yaml',
  yml: 'yaml',
  graphql: 'graphql',
  gql: 'graphql',
  tf: 'terraform',
  tfvars: 'terraform-vars',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  proto: 'proto',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript'
}

/** The LSP language id for a file, from its extension (VS Code's ids); null for languages no server here takes. */
export function languageIdFor(relPath: string): string | null {
  const name = relPath.split('/').pop() ?? relPath
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return LANGUAGE_IDS[name.slice(dot + 1).toLowerCase()] ?? null
}
