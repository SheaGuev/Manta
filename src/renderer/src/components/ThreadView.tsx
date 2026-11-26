import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { unifiedMergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Bot, Check, CornerLeftUp, EyeOff, FileText, Hammer, MessageSquarePlus, Send, ShieldQuestion, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Streamdown, type LinkSafetyConfig } from 'streamdown'
import 'streamdown/styles.css'
import type { PermissionDecision, ThreadInfo, ThreadLanded, ThreadMessage, ThreadProposal } from '../../../shared/ipc'
import { diffLineCounts } from '../lib/diffStats'
import { overlayScrollbars } from '../lib/overlayScrollbars'
import { displayName } from '../lib/tree'

const api = window.manta
/** Main opens every link in the browser, so streamdown's confirm-before-opening modal is redundant. Module-level: `Streamdown` re-renders when this changes identity. */
export const LINK_SAFETY: LinkSafetyConfig = { enabled: false }

interface ThreadViewProps {
  root: string
  relPath: string
  id: string
  onOpenDoc: (relPath: string) => void
  onOpenThread: (thread: ThreadInfo) => void
  /** Start implementing this thread's section in a code worktree; top-level doc threads only. */
  onImplement: (thread: ThreadInfo) => void
  onError: (message: string) => void
}

/** One thread in its own tab: transcript, composer, and the edit it proposes for its doc. */
export function ThreadView({ root, relPath, id, onOpenDoc, onOpenThread, onImplement, onError }: ThreadViewProps): React.JSX.Element {
  const [info, setInfo] = useState<ThreadInfo | null>(null)
  const [parent, setParent] = useState<ThreadInfo | null>(null)
  /** The implementation thread whose session proposed this one. */
  const [proposer, setProposer] = useState<ThreadInfo | null>(null)
  const [subthreads, setSubthreads] = useState<ThreadInfo[]>([])
  const [newSubthread, setNewSubthread] = useState<string | null>(null)
  /** Tool calls the agent is waiting on the user to allow. */
  const [asks, setAsks] = useState<{ id: string; tool: string; summary: string; title: string | null }[]>([])
  const [transcript, setTranscript] = useState<ThreadMessage[]>([])
  /** Messages of the running turn, shown until the turn ends and the saved transcript has them. */
  const [live, setLive] = useState<ThreadMessage[]>([])
  const [proposal, setProposal] = useState<ThreadProposal | null>(null)
  /** For a merged thread, the change as it was committed. */
  const [landed, setLanded] = useState<ThreadLanded | null>(null)
  const [running, setRunning] = useState(false)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const end = useRef<HTMLDivElement>(null)
  /** Read by the file-change listener, which is added once per thread. */
  const followsDoc = useRef(true)
  followsDoc.current = info?.status !== 'merged'

  const report = useCallback((error: unknown) => onError(error instanceof Error ? error.message : String(error)), [onError])

  const load = useCallback(async () => {
    const [thread, messages, next, children] = await Promise.all([
      api.getThread(root, relPath, id),
      api.threadTranscript(root, id),
      api.threadProposal(root, relPath, id),
      api.listSubthreads(root, relPath, id)
    ])
    setInfo(thread)
    setParent(thread?.parent ? await api.getThread(root, relPath, thread.parent) : null)
    setProposer(thread?.proposedBy ? await api.getThread(root, thread.proposedBy.doc, thread.proposedBy.thread).catch(() => null) : null)
    setTranscript(messages)
    setProposal(next)
    setSubthreads(children)
    setLanded(thread?.status === 'merged' && thread.parent === null ? await api.threadLanded(root, relPath, id) : null)
  }, [root, relPath, id])

  useEffect(() => {
    load().catch(report)
    /**
     * Revising, withdrawing and status changes rewrite thread records. Edits to the doc change what an
     * open thread would merge; a merged thread's landed diff is fixed, and reloading it runs git.
     */
    const stopFiles = api.onFilesChanged((change) => {
      if (change.root !== root) return
      if (change.records.length > 0 || (change.content && followsDoc.current)) void load().catch(report)
    })
    const stopEvents = api.onThreadEvent((r, doc, threadId, event) => {
      if (r !== root || doc !== relPath || threadId !== id) return
      const at = new Date().toISOString()
      if (event.type === 'turn-start') {
        // The saved transcript has the user's message by now; drop the optimistic copy.
        setRunning(true)
        void load()
          .then(() => setLive((m) => m.filter((message) => message.role !== 'user')))
          .catch(report)
      }
      else if (event.type === 'text') setLive((m) => appendText(m, event.text, at))
      else if (event.type === 'tool') setLive((m) => [...m, { role: 'tool', text: `${event.name} ${event.summary}`.trim(), at }])
      else if (event.type === 'error') setLive((m) => [...m, { role: 'status', text: `Error: ${event.message}`, at }])
      else if (event.type === 'proposal-changed') void api.threadProposal(root, relPath, id).then(setProposal, report)
      else if (event.type === 'permission') setAsks((a) => [...a, { id: event.id, tool: event.tool, summary: event.summary, title: event.title }])
      else if (event.type === 'permission-resolved') setAsks((a) => a.filter((ask) => ask.id !== event.id))
      else {
        setRunning(false)
        setAsks([])
        void load()
          .then(() => setLive([]))
          .catch(report)
      }
    })
    return () => {
      stopFiles()
      stopEvents()
    }
  }, [root, relPath, id, load, report])

  // Block body: in current Chromium `scrollIntoView` returns a Promise, which React would take for a cleanup.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' })
  }, [transcript, live])

  const send = (): void => {
    const text = draft.trim()
    if (!text || running) return
    setDraft('')
    setNotice(null)
    setLive([{ role: 'user', text, at: new Date().toISOString() }])
    api
      .sendThreadMessage(root, relPath, id, text)
      .then((result) => {
        if (result.ok) return
        setLive([])
        setDraft(text)
        setNotice({ text: result.message, error: true })
      })
      .catch(report)
  }

  const approve = (): void =>
    void api
      .approveThread(root, relPath, id)
      .then(async (result) => {
        setNotice({ text: result.message, error: !result.ok })
        await load()
        // Show the doc, where the thread's change is now highlighted.
        if (result.ok && !parent) onOpenDoc(relPath)
      })
      .catch(report)

  const discard = (): void => {
    if (!window.confirm('Discard this thread? It stays in the doc\'s thread list, marked discarded.')) return
    void api
      .setThreadStatus(root, relPath, id, 'discarded')
      .then(() => load())
      .catch(report)
  }

  const hideChanges = (): void =>
    void api
      .dismissThreadChanges(root, relPath, id)
      .then(() => load())
      .catch(report)

  const answer = (requestId: string, decision: PermissionDecision): void =>
    void api.answerThreadPermission(root, id, requestId, decision).catch(report)

  const startSubthread = (title: string): void =>
    void api
      .createSubthread(root, relPath, id, title)
      .then((thread) => {
        setNewSubthread(null)
        onOpenThread(thread)
      })
      .catch(report)

  const section = info?.range && proposal ? proposal.current.slice(info.range.from, info.range.to) : null
  const hasChange = proposal !== null && proposal.merged !== proposal.current
  const shown = proposal && hasChange ? { before: proposal.current, after: proposal.merged } : landed ? { before: landed.before, after: landed.after } : null
  const open = info?.status === 'open'
  const messages = [...transcript, ...live]

  return (
    <div className="thread-view">
      <div className="thread-scroll">
        <div className="thread-column">
          {parent && (
            <button className="icon-button thread-parent" title="Open the parent thread" onClick={() => onOpenThread(parent)}>
              <CornerLeftUp size={14} /> Subthread of {parent.title}
            </button>
          )}
          {proposer && (
            <button className="icon-button thread-parent" title="Open the implementation session that proposed this" onClick={() => onOpenThread(proposer)}>
              <Bot size={14} /> Proposed by the implementation {proposer.title}
            </button>
          )}
          <div className="thread-head">
            <h2>{info?.title ?? 'Thread'}</h2>
            {info && <span className={`thread-status ${info.range ? info.status : 'detached'}`}>{info.range ? info.status : 'detached'}</span>}
            <span className="grow" />
            {info && info.parent === null && info.range && info.status !== 'discarded' && (
              <button className="icon-button" title="Implement this thread's section in a code worktree" onClick={() => onImplement(info)}>
                <Hammer size={14} /> Implement
              </button>
            )}
            {open && (
              <button className="icon-button" title="Discard this thread" onClick={discard}>
                <Trash2 size={14} /> Discard
              </button>
            )}
            <button className="icon-button" title="Open the doc" onClick={() => onOpenDoc(relPath)}>
              <FileText size={14} /> {displayName(relPath)}
            </button>
          </div>

          <blockquote className="thread-section">
            {section ?? (info ? 'The section this thread was about has been deleted.' : '')}
          </blockquote>

          <div className="transcript">
            {messages.length === 0 && <div className="muted-row">Ask the agent to help scope this section. It can only edit a copy of the doc; you approve the result.</div>}
            {messages.map((message, index) => (
              <div key={`${message.at}-${index}`} className={`message ${message.role}`}>
                {message.role === 'assistant' ? (
                  <Streamdown animated isAnimating={running && index === messages.length - 1} controls={false} linkSafety={LINK_SAFETY}>
                    {message.text}
                  </Streamdown>
                ) : (
                  message.text
                )}
              </div>
            ))}
            {running && <div className="message status">Working…</div>}
            <div ref={end} />
          </div>

          {notice && <div className={`thread-notice ${notice.error ? 'error' : ''}`}>{notice.text}</div>}

          {(shown || info?.highlighted) && (
            <section className="proposal">
              <div className="proposal-head">
                <span className="proposal-title">{landed && !hasChange ? 'Merged change' : parent ? "Proposed edit to the parent's proposal" : 'Proposed edit'}</span>
                {shown && <LineCounts before={shown.before} after={shown.after} />}
                {landed && !hasChange && <span className="muted-row">commit {landed.commit.slice(0, 7)}</span>}
                <span className="grow" />
                {info?.highlighted && (
                  <button className="primary-button small" title="Stop highlighting what this thread changed in the doc" onClick={hideChanges}>
                    <EyeOff size={13} /> Hide changes in doc
                  </button>
                )}
                {open && (
                  <button className="primary-button small accent" disabled={!hasChange || running} onClick={approve}>
                    <Check size={13} /> {parent ? 'Approve into parent' : 'Approve'}
                  </button>
                )}
              </div>
              {shown && <ProposalDiff current={shown.before} merged={shown.after} />}
            </section>
          )}

          {(open || subthreads.length > 0) && (
            <section className="subthreads">
              <div className="group-label">Subthreads</div>
              {subthreads.map((thread) => (
                <div key={thread.id} className="row thread-row" title={thread.title} onClick={() => onOpenThread(thread)}>
                  <span className={`thread-dot ${thread.range ? thread.status : 'detached'}`} />
                  <span className="label">{thread.title}</span>
                  <span className="muted-row">{thread.range ? thread.status : 'detached'}</span>
                </div>
              ))}
              {open &&
                (newSubthread === null ? (
                  <div className="row" title="Explore part of this thread on its own, then approve it into this one" onClick={() => setNewSubthread('')}>
                    <MessageSquarePlus size={14} />
                    <span className="label">New subthread</span>
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (newSubthread.trim()) startSubthread(newSubthread.trim())
                    }}
                  >
                    <input
                      className="inline-input"
                      autoFocus
                      value={newSubthread}
                      placeholder="What should the subthread figure out?"
                      onChange={(e) => setNewSubthread(e.target.value)}
                      onKeyDown={(e) => e.key === 'Escape' && setNewSubthread(null)}
                      onBlur={() => !newSubthread.trim() && setNewSubthread(null)}
                    />
                  </form>
                ))}
            </section>
          )}
        </div>
      </div>

      {asks.map((ask) => (
        <div key={ask.id} className="permission-card">
          <ShieldQuestion size={16} />
          <div className="permission-text">
            <div>{ask.title ?? `The agent wants to use ${ask.tool}`}</div>
            {ask.summary && <code>{ask.summary}</code>}
          </div>
          <button className="primary-button" onClick={() => answer(ask.id, 'deny')}>
            Deny
          </button>
          <button className="primary-button" title="Allow this for the rest of this thread's session" onClick={() => answer(ask.id, 'always')}>
            Always for this thread
          </button>
          <button className="primary-button accent" onClick={() => answer(ask.id, 'allow')}>
            Allow
          </button>
        </div>
      ))}

      {open && (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <textarea
            value={draft}
            placeholder={running ? 'The agent is working…' : 'Message the agent'}
            rows={2}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          {running ? (
            <button type="button" className="primary-button" title="Stop the agent" onClick={() => void api.cancelThreadTurn(root, id).catch(report)}>
              <Square size={14} /> Stop
            </button>
          ) : (
            <button type="submit" className="primary-button accent" disabled={!draft.trim()}>
              <Send size={14} /> Send
            </button>
          )}
        </form>
      )}
    </div>
  )
}

/** Adds streamed text to the last agent message, or starts one. */
export function appendText(messages: ThreadMessage[], text: string, at: string): ThreadMessage[] {
  const last = messages.at(-1)
  if (last?.role === 'assistant') return [...messages.slice(0, -1), { ...last, text: last.text + text }]
  return [...messages, { role: 'assistant', text, at }]
}

export function LineCounts({ before, after }: { before: string; after: string }): React.JSX.Element {
  const { added, removed } = useMemo(() => diffLineCounts(before, after), [before, after])
  return (
    <span className="proposal-counts">
      <span className="add">+{added}</span> <span className="del">−{removed}</span>
    </span>
  )
}

/** Read-only diff of the doc as it is now against the doc after approving (R8: never against the fork point). */
export function ProposalDiff({ current, merged }: { current: string; merged: string }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current) return
    // A doc's final newline would show as an empty last line under the diff.
    const trim = (text: string): string => text.replace(/\n+$/, '')
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: trim(merged),
        extensions: [
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage }),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          overlayScrollbars,
          unifiedMergeView({ original: trim(current), mergeControls: false, gutter: true, collapseUnchanged: { margin: 2, minSize: 4 } })
        ]
      })
    })
    return () => view.destroy()
  }, [current, merged])
  return <div className="editor proposal-diff" ref={host} />
}
