import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { unifiedMergeView } from '@codemirror/merge'
import { lintGutter } from '@codemirror/lint'
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import type { OpResult } from '../../../shared/ipc'
import { languageIdFor } from '../../../shared/languages'
import { codeHighlight } from '../lib/codeHighlight'
import { diffInsertions } from '../lib/diffInsertions'
import { diffOverview } from '../lib/diffOverview'
import { codeEditing, findInFile, wordCompletion } from '../lib/editorBasics'
import { joinPeers } from '../lib/editorPeers'
import { overlayScrollbars } from '../lib/overlayScrollbars'
import { livePreview } from '../lib/livePreview'
import { clientRoot, clientsFor, onServersChanged } from '../lib/lsp/clients'
import { codeIntelligence } from '../lib/lsp/codeIntelligence'
import { fileUri } from '../lib/lsp/fileUris'
import { formatWithServer } from '../lib/lsp/formatting'
import { editorKey, noteEditor } from '../lib/lsp/navigation'
import { lineToReveal } from '../lib/reviewAnchors'
import { threadMarkers, type ThreadHandlers } from '../lib/threadMarkers'
import { useDiffComments } from './DiffComments'

const MAIN_ORIGIN = 'main'
/** Languages `@codemirror/language-data` doesn't highlight, bundled because the core plugins' servers need them. */
const EXTRA_LANGUAGES = [
  LanguageDescription.of({ name: 'GraphQL', extensions: ['graphql', 'gql'], load: () => import('cm6-graphql').then((m) => m.graphqlLanguageSupport()) }),
  LanguageDescription.of({ name: 'HCL', extensions: ['tf', 'tfvars', 'hcl'], load: () => import('codemirror-lang-hcl').then((m) => m.hcl()) })
]
const api = window.manta

/** `readonly`: a file the editor shouldn't change, such as a definition in `node_modules`; its `relPath` is absolute. */
export type EditorMode = 'doc' | 'code' | 'diff' | 'readonly'

interface EditorProps {
  root: string
  /** Relative to `root`; absolute in `readonly` mode. */
  relPath: string
  mode: EditorMode
  /** Its tab is showing; a code file takes focus when it comes back into view. */
  visible: boolean
  onError: (message: string) => void
  /** Reports where the cursor is, e.g. so a new thread can anchor to that section. */
  onCursor?: (offset: number) => void
  /** Thread markers and the heading "+ thread" button; docs-repo docs only. */
  threads?: ThreadHandlers
  /** Moves the cursor to this 1-based line and scrolls it into view; a new `seq` reveals again. */
  revealLine?: { line: number; seq: number; side?: 'old' | 'new' }
  /** What Cmd+S did, for the status bar: formatted with what, or saved, or why formatting failed. */
  onSaved?: (result: OpResult) => void
  /** What sending review comments from a diff did. */
  onResult?: (result: OpResult) => void
  /** Shown inside a page rather than as a tab: it grows with its text and leaves go-to-definition to the tab. */
  embedded?: boolean
}

async function modeExtensions(root: string, relPath: string, mode: EditorMode): Promise<Extension[]> {
  if (mode === 'doc') return [EditorView.lineWrapping, markdown({ base: markdownLanguage }), livePreview, findInFile]
  const language = LanguageDescription.matchFilename([...EXTRA_LANGUAGES, ...languages], relPath)
  const support = language ? await language.load() : []
  const viewing = [lineNumbers(), highlightActiveLineGutter(), support, codeHighlight, findInFile]
  if (mode === 'readonly') return [...viewing, EditorState.readOnly.of(true)]
  const code = [...viewing, codeEditing]
  if (mode === 'code') return code
  const original = (await api.fileAtHead(root, relPath)) ?? ''
  return [...code, unifiedMergeView({ original, mergeControls: false, gutter: true }), diffInsertions, diffOverview]
}

function revealAt(view: EditorView, line: number): void {
  const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines))
  view.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: 'center' }) })
  view.focus()
}

/** A CodeMirror view over a Yjs replica of the main process's copy of the file. */
export function Editor({ root, relPath, mode, visible, onError, onCursor, threads, revealLine, onSaved, onResult, embedded }: EditorProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const comments = useDiffComments({ root: mode === 'diff' ? root : null, relPath, diff: 'changes', onResult: (result) => onResult?.(result), onError })
  const viewRef = useRef<EditorView | null>(null)
  const reveal = useRef(revealLine)
  reveal.current = revealLine
  /** The last reveal applied, so rebuilding the view doesn't jump back to it. */
  const revealed = useRef<number | null>(null)
  const applyReveal = (view: EditorView): void => {
    const pending = reveal.current
    if (!pending || pending.seq === revealed.current) return
    revealed.current = pending.seq
    /** An old-side line (a review comment on a deleted line) is a line of the original; the diff maps it. */
    revealAt(view, mode === 'diff' && pending.side === 'old' ? lineToReveal(view.state, 'old', pending.line) : pending.line)
  }
  // Read through a ref so a new callback each render doesn't rebuild the editor.
  const cursorListener = useRef(onCursor)
  cursorListener.current = onCursor
  const threadHandlers = useRef(threads)
  threadHandlers.current = threads
  const savedListener = useRef(onSaved)
  savedListener.current = onSaved
  const withThreads = threads !== undefined

  useEffect(() => {
    let disposed = false
    let view: EditorView | null = null
    let forgetEditor: (() => void) | null = null
    let stopServerChanges: (() => void) | null = null
    const readOnly = mode === 'readonly'
    const doc = new Y.Doc()
    /** Word completion until a language server is ready, then the primary server's intelligence. */
    const intelligence = new Compartment()
    /** Lint servers beside the primary one (ESLint, Biome, Ruff). */
    const linting = new Compartment()
    const stopRemote = readOnly
      ? () => undefined
      : api.onRemoteUpdate((updateRoot, path, update) => {
          if (updateRoot === root && path === relPath) Y.applyUpdate(doc, update, MAIN_ORIGIN)
        })
    const peer = readOnly ? null : joinPeers(editorKey(root, relPath), (update) => Y.applyUpdate(doc, update, MAIN_ORIGIN))

    let serverName: string | null = null
    /** The editor mounts first, so a server that's slow to start never holds up showing the file. */
    const attachLanguageServer = (target: EditorView): void => {
      const languageId = languageIdFor(relPath)
      if (!languageId) return
      clientsFor(root, languageId)
        .then((servers) => {
          if (disposed) return
          const primary = servers.find((s) => s.role === 'primary')
          serverName = primary?.name ?? null
          const lints = servers.flatMap((s) => (s.lint ? [s.lint.editorExtension({ uri: fileUri(s.rootUri, relPath), languageId })] : []))
          /** Both are set every time: after a plugin is removed, the editor drops its server too. */
          target.dispatch({
            effects: [
              intelligence.reconfigure(primary ? codeIntelligence({ client: primary.client, uri: fileUri(primary.rootUri, relPath), languageId, clientRoot }) : wordCompletion),
              linting.reconfigure(lints.length > 0 ? [lintGutter(), ...lints] : [])
            ]
          })
        })
        /** The status bar shows a server that failed; the editor keeps working without it. */
        .catch((error: unknown) => console.warn('manta: language server', error))
    }

    /**
     * Cmd+S: Manta saves as you type anyway, so this is "format, then save now". Code files use the
     * project's formatter, or the language server's when the project has none; docs only save.
     */
    const save = async (target: EditorView): Promise<OpResult> => {
      if (mode === 'code') {
        const result = await api.formatFile(root, relPath)
        if (result.formatter !== null) {
          if (!result.ok) await api.saveFile(root, relPath)
          return result
        }
        const formatted = await formatWithServer(target).catch(() => false)
        await api.saveFile(root, relPath)
        return { ok: true, message: formatted && serverName ? `Formatted with ${serverName}` : 'Saved' }
      }
      await api.saveFile(root, relPath)
      return { ok: true, message: 'Saved' }
    }
    const saveKeymap = Prec.high(
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: (target) => {
            save(target)
              .then((result) => savedListener.current?.(result))
              .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
            return true
          }
        }
      ])
    )

    const content = readOnly
      ? api.readOnlyFile(root, relPath).then((text) => {
          if (text === null) throw new Error(`Can't show ${relPath}`)
          return text
        })
      : api.openDoc(root, relPath).then((state) => {
          Y.applyUpdate(doc, state, MAIN_ORIGIN)
          return null
        })

    Promise.all([content, modeExtensions(root, relPath, mode)])
      .then(([readOnlyText, extensions]) => {
        if (disposed || !host.current) return
        const text = doc.getText('md')
        if (!readOnly)
          doc.on('update', (update: Uint8Array, origin: unknown) => {
            if (origin === MAIN_ORIGIN) return
            api.pushUpdate(root, relPath, update)
            peer?.share(update)
          })
        // yCollab only syncs changes made after mount; the starting text must be passed in.
        view = new EditorView({
          parent: host.current,
          doc: readOnlyText ?? text.toString(),
          extensions: [
            keymap.of([...(readOnly ? [] : yUndoManagerKeymap), ...defaultKeymap, indentWithTab]),
            drawSelection(),
            dropCursor(),
            overlayScrollbars,
            ...extensions,
            ...(mode === 'doc' && withThreads ? [threadMarkers(doc, relPath, threadHandlers)] : []),
            ...(mode === 'diff' ? [comments.extension] : []),
            intelligence.of(mode === 'code' ? wordCompletion : []),
            linting.of([]),
            ...(mode === 'code' || mode === 'doc' ? [saveKeymap] : []),
            EditorView.updateListener.of((update) => {
              if (update.selectionSet || update.docChanged) cursorListener.current?.(update.state.selection.main.head)
            }),
            ...(readOnly ? [] : [yCollab(text, null)])
          ]
        })
        viewRef.current = view
        if (mode === 'diff') comments.attach(view)
        /** A diff tab of the same file would take the key, and a jump to definition should land in the code tab. */
        if (mode !== 'diff' && !embedded) forgetEditor = noteEditor(editorKey(root, relPath), view)
        if (mode === 'code') {
          const target = view
          view.focus()
          attachLanguageServer(target)
          stopServerChanges = onServersChanged(() => attachLanguageServer(target))
        }
        applyReveal(view)
      })
      .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))

    return () => {
      disposed = true
      stopRemote()
      peer?.leave()
      forgetEditor?.()
      stopServerChanges?.()
      comments.attach(null)
      viewRef.current = null
      view?.destroy()
      doc.destroy()
    }
  }, [root, relPath, mode, onError, withThreads, comments.extension, comments.attach, embedded])

  useEffect(() => {
    if (viewRef.current) applyReveal(viewRef.current)
  }, [revealLine?.seq])

  useEffect(() => {
    if (visible && mode === 'code') viewRef.current?.focus()
  }, [visible, mode])

  return (
    <>
      <div className={`editor ${mode === 'doc' ? 'doc' : 'code'} ${embedded ? 'embedded' : ''}`} ref={host} />
      {comments.picker}
    </>
  )
}
