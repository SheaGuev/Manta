import { Send, ShieldQuestion, Sparkles, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'
import type { MapDetail, PermissionDecision, ThreadMessage } from '../../../shared/ipc'
import type { MapActions } from './MapView'
import { appendText, LINK_SAFETY } from './ThreadView'

const api = window.manta

/** Enough of the conversation to see what the last turns did; older messages stay in its state. */
const SHOWN_MESSAGES = 30

/**
 * Ask the map: a conversation with the map agent, which has the map tools and reads the docs repo and
 * code projects. It answers questions and proposes plans, which land in Needs review; it never edits
 * the map or the docs itself.
 */
export function MapAsk({ map, actions, draft: initialDraft, onReload }: { map: MapDetail; actions: MapActions; draft: string; onReload: () => void }): React.JSX.Element {
  const [live, setLive] = useState<ThreadMessage[]>([])
  const [asks, setAsks] = useState<{ id: string; tool: string; summary: string; title: string | null }[]>([])
  const [draft, setDraft] = useState(initialDraft)
  const reloadRef = useRef(onReload)
  reloadRef.current = onReload
  const { docsRoot, report } = actions

  useEffect(
    () =>
      api.onMapEvent((root, mapId, event) => {
        if (root !== docsRoot || mapId !== map.id) return
        const at = new Date().toISOString()
        if (event.type === 'turn-start') setLive((m) => m.filter((message) => message.role !== 'user'))
        else if (event.type === 'text') setLive((m) => appendText(m, event.text, at))
        else if (event.type === 'tool') setLive((m) => [...m, { role: 'tool', text: `${event.name} ${event.summary}`.trim(), at }])
        else if (event.type === 'error') setLive((m) => [...m, { role: 'status', text: `Error: ${event.message}`, at }])
        else if (event.type === 'permission') setAsks((a) => [...a, { id: event.id, tool: event.tool, summary: event.summary, title: event.title }])
        else if (event.type === 'permission-resolved') setAsks((a) => a.filter((ask) => ask.id !== event.id))
        else if (event.type === 'turn-end') {
          setAsks([])
          setLive([])
          reloadRef.current()
        }
      }),
    [docsRoot, map.id]
  )

  const running = map.running
  const send = (): void => {
    const text = draft.trim()
    if (!text || running) return
    setDraft('')
    setLive([{ role: 'user', text, at: new Date().toISOString() }])
    void api
      .sendMapMessage(docsRoot, map.id, text)
      .then((result) => !result.ok && report(new Error(result.message)))
      .catch(report)
      .finally(() => reloadRef.current())
  }
  const answer = (requestId: string, decision: PermissionDecision): void => void api.answerMapPermission(docsRoot, map.id, requestId, decision).catch(report)
  const messages = [...map.messages, ...live].slice(-SHOWN_MESSAGES)

  return (
    <div className="thread-view">
      <div className="thread-scroll">
        <div className="thread-column">
          <div className="thread-head">
            <h2>
              <button className="map-crumb" onClick={() => actions.openScreen('home')}>
                {map.title}
              </button>{' '}
              / Ask the map
            </h2>
            <span className="grow" />
            <button className="icon-button" title="Propose milestones and tickets from the map's docs" disabled={running} onClick={actions.breakDown}>
              <Sparkles size={14} /> Break down
            </button>
          </div>
          {messages.length === 0 && (
            <p className="muted-row map-description">
              Ask about the work (“how does the brief get built?”, “what’s left before the next milestone?”) or plan it. Plans it proposes wait in Needs review; it never changes the map or the docs itself. It uses your Claude Code.
            </p>
          )}
          <div className="transcript">
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
          </div>
        </div>
      </div>

      {asks.map((ask) => (
        <div key={ask.id} className="permission-card">
          <ShieldQuestion size={16} />
          <div className="permission-text">
            <div>{ask.title ?? `The map agent wants to use ${ask.tool}`}</div>
            {ask.summary && <code>{ask.summary}</code>}
          </div>
          <button className="primary-button" onClick={() => answer(ask.id, 'deny')}>
            Deny
          </button>
          <button className="primary-button" title="Allow this for the rest of the map agent's session" onClick={() => answer(ask.id, 'always')}>
            Always for this map
          </button>
          <button className="primary-button accent" onClick={() => answer(ask.id, 'allow')}>
            Allow
          </button>
        </div>
      ))}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <textarea
          value={draft}
          placeholder={running ? 'The map agent is working…' : 'Ask the map'}
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
          <button type="button" className="primary-button" title="Stop the map agent" onClick={() => void api.cancelMapTurn(docsRoot, map.id).catch(report)}>
            <Square size={14} /> Stop
          </button>
        ) : (
          <button type="submit" className="primary-button accent" disabled={!draft.trim()}>
            <Send size={14} /> Send
          </button>
        )}
      </form>
    </div>
  )
}
