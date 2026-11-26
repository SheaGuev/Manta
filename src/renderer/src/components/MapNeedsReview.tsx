import { Check, X } from 'lucide-react'
import { useState } from 'react'
import type { MapDetail, MapSuggestion, PlanChange } from '../../../shared/ipc'
import { reviewButton, reviewSentence, type ReviewItem } from '../lib/mapUpNext'
import { Chip } from './MapOverview'
import type { MapActions } from './MapView'

/**
 * The Overview's Needs review: suggestions to approve or dismiss right there (a plan's milestones
 * and a plan change's steps picked one by one), and what else waits on the user that Needs your
 * attention leaves out.
 */
export function NeedsReview({ items, map, actions }: { items: readonly ReviewItem[]; map: MapDetail; actions: MapActions }): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <section className="map-ov-section" id="map-needs-review">
      <div className="map-ov-section-head">
        <h2>Needs review</h2>
        <Chip tone="muted">{items.length}</Chip>
      </div>
      <div className="map-card map-ov-list">
        {items.map((item) => (
          <ReviewRow key={reviewKey(item)} item={item} map={map} actions={actions} />
        ))}
      </div>
    </section>
  )
}

function reviewKey(item: ReviewItem): string {
  if (item.kind === 'proposal') return item.proposal.thread
  if (item.kind === 'suggestion') return item.suggestion.id
  if (item.kind === 'waiting') return item.terminal.id
  if (item.kind === 'blocked') return item.ticket.id
  return `${item.kind}:${item.launch.id}`
}

/** One thing in Needs review, with what can be done about it right there. */
function ReviewRow({ item, map, actions }: { item: ReviewItem; map: MapDetail; actions: MapActions }): React.JSX.Element {
  if (item.kind === 'suggestion') return <SuggestionRow suggestion={item.suggestion} map={map} actions={actions} />
  return (
    <div className="map-review-row">
      <span className="map-review-text" title={reviewSentence(item)}>
        {reviewSentence(item)}
      </span>
      <button className="map-button" onClick={() => actions.review(item)}>
        {reviewButton(item)}
      </button>
    </div>
  )
}

/** One proposed plan change in words, naming tickets and milestones by title. */
function planChangeText(change: PlanChange, map: MapDetail): string {
  const tickets = map.milestones.flatMap((m) => m.tickets)
  const ticket = (id: string): string => `“${tickets.find((t) => t.id === id)?.title ?? 'a removed ticket'}”`
  const milestone = (id: string): string => `“${map.milestones.find((m) => m.id === id)?.title ?? 'a removed milestone'}”`
  switch (change.kind) {
    case 'update-ticket': {
      const parts = [
        ...(change.title !== undefined ? [`rename it “${change.title}”`] : []),
        ...(change.description !== undefined ? ['rewrite its description'] : []),
        ...(change.acceptance !== undefined ? [`set ${change.acceptance.length} acceptance criteria`] : []),
        ...(change.after !== undefined ? [change.after.length > 0 ? `wait for ${change.after.map(ticket).join(', ')}` : 'wait for nothing'] : []),
        ...(change.project !== undefined ? [`move it to ${change.project ?? 'the map’s project'}`] : [])
      ]
      return `Change ${ticket(change.ticket)}: ${parts.join(', ')}`
    }
    case 'add-ticket':
      return `Add “${change.ticket.title}” to ${milestone(change.milestone)}${change.ticket.description ? `: ${change.ticket.description.split('\n')[0]}` : ''}`
    case 'move-ticket':
      return `Move ${ticket(change.ticket)} to ${milestone(change.milestone)}${change.before ? `, before ${ticket(change.before)}` : ''}`
    case 'remove-ticket':
      return `Drop ${ticket(change.ticket)}`
    case 'update-milestone':
      return `Change ${milestone(change.milestone)}${change.title !== undefined ? `: rename it “${change.title}”` : ''}${change.description !== undefined ? `${change.title !== undefined ? ',' : ':'} rewrite its description` : ''}`
    case 'move-milestone':
      return `Move ${milestone(change.milestone)} ${change.before ? `before ${milestone(change.before)}` : 'to the end'}`
  }
}

function SuggestionRow({ suggestion, map, actions }: { suggestion: MapSuggestion; map: MapDetail; actions: MapActions }): React.JSX.Element {
  const items = suggestion.kind === 'plan' ? suggestion.milestones.length : suggestion.kind === 'plan-change' ? suggestion.changes.length : 0
  const picking = suggestion.kind === 'plan' || suggestion.kind === 'plan-change'
  const [pick, setPick] = useState<number[]>(Array.from({ length: items }, (_, i) => i))
  const toggle = (index: number, on: boolean): void => setPick((p) => (on ? [...p, index].sort((a, b) => a - b) : p.filter((i) => i !== index)))
  const accept = suggestion.kind === 'add-doc' ? 'Add' : suggestion.kind === 'write-doc' ? 'Write' : picking ? (pick.length === items ? 'Approve all' : `Approve ${pick.length}`) : 'Add ticket'
  return (
    <div className="map-review-row suggestion">
      <div className="map-review-text">
        <div>{reviewSentence({ kind: 'suggestion', suggestion })}</div>
        {suggestion.why && <div className="muted-row">{suggestion.why}</div>}
        {suggestion.kind === 'ticket' && <div className="muted-row">In {map.milestones.find((m) => m.id === suggestion.milestone)?.title ?? 'a removed milestone'}: {suggestion.ticket.description}</div>}
        {suggestion.kind === 'plan' && (
          <div className="map-plan">
            {suggestion.milestones.map((m, index) => (
              <label key={`${m.title}-${index}`} className="map-plan-milestone">
                <input type="checkbox" checked={pick.includes(index)} onChange={(e) => toggle(index, e.target.checked)} />
                <span>
                  <strong>{m.title}</strong>
                  {m.description && <span className="muted-row"> · {m.description}</span>}
                  {m.tickets.length > 0 && (
                    <ul>
                      {m.tickets.map((t, i) => (
                        <li key={`${t.title}-${i}`}>
                          {t.title}
                          {(t.acceptance.length > 0 || t.after.length > 0 || t.project) && (
                            <span className="muted-row">
                              {' '}
                              · {[...(t.acceptance.length > 0 ? [`${t.acceptance.length} criteria`] : []), ...(t.after.length > 0 ? [`after ${t.after.join(', ')}`] : []), ...(t.project ? [t.project] : [])].join(' · ')}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}
        {suggestion.kind === 'plan-change' && (
          <div className="map-plan">
            {suggestion.changes.map((change, index) => (
              <label key={`${change.kind}-${index}`} className="map-plan-milestone">
                <input type="checkbox" checked={pick.includes(index)} onChange={(e) => toggle(index, e.target.checked)} />
                <span>{planChangeText(change, map)}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      <button className="icon-button" title="Dismiss" onClick={() => actions.resolve(suggestion.id, false)}>
        <X size={13} />
      </button>
      <button className="map-button" disabled={picking && pick.length === 0} onClick={() => actions.resolve(suggestion.id, true, picking ? pick : null)}>
        <Check size={12} /> {accept}
      </button>
    </div>
  )
}
