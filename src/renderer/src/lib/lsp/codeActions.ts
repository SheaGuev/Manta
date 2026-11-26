import { LSPPlugin } from '@codemirror/lsp-client'
import type { EditorView } from '@codemirror/view'
import { applyWorkspaceEdit, type ClientRoot } from './applyEdit'
import { serverDiagnosticsAt } from './pullDiagnostics'

/** A quick fix or refactor the server offers at the cursor. */
export interface QuickFix {
  title: string
  /** `quickfix`, `refactor.extract`, `source.organizeImports` and so on. */
  kind: string
  preferred: boolean
  /** The action as the server sent it, for `codeAction/resolve` and its edit. */
  action: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * The server's quick fixes for the cursor's line (`textDocument/codeAction`), with the line's errors as
 * context, which TypeScript needs to offer fixes such as adding a missing import. Actions that only
 * run a command are left out: they edit through `workspace/applyEdit`, which Manta doesn't take.
 */
export async function quickFixes(view: EditorView): Promise<QuickFix[] | null> {
  const plugin = LSPPlugin.get(view)
  if (!plugin?.client.serverCapabilities?.codeActionProvider) return null
  plugin.client.sync()
  const { head } = view.state.selection.main
  const line = view.state.doc.lineAt(head)
  const range = { start: plugin.toPosition(line.from), end: plugin.toPosition(line.to) }
  const diagnostics = serverDiagnosticsAt(view, line.number - 1)
  const response: unknown = await plugin.client.request('textDocument/codeAction', { textDocument: { uri: plugin.uri }, range, context: { diagnostics, triggerKind: 1 } })
  if (!Array.isArray(response)) return []
  return response.filter(isRecord).flatMap((action) => {
    if (typeof action.title !== 'string' || ('command' in action && typeof action.command === 'string')) return []
    if (!action.edit && !action.data) return []
    return [{ title: action.title, kind: typeof action.kind === 'string' ? action.kind : '', preferred: action.isPreferred === true, action }]
  }).sort((a, b) => Number(b.preferred) - Number(a.preferred) || Number(b.kind.startsWith('quickfix')) - Number(a.kind.startsWith('quickfix')))
}

/** Applies a quick fix, asking the server for its edit first when it sent the action without one. */
export async function applyQuickFix({ view, fix, clientRoot }: { view: EditorView; fix: QuickFix; clientRoot: ClientRoot }): Promise<void> {
  const plugin = LSPPlugin.get(view)
  if (!plugin) return
  const { client } = plugin
  await client.withMapping(async (mapping) => {
    const resolved: unknown = fix.action.edit ? fix.action : await client.request('codeAction/resolve', fix.action)
    const edit = isRecord(resolved) ? resolved.edit : undefined
    if (edit) await applyWorkspaceEdit({ client, edit, mapping, clientRoot, userEvent: 'quickfix' })
  })
}
