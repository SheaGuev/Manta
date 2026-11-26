import { AlertTriangle, ArrowRight, Check, Circle, ExternalLink, FilePlus, FileText, Link2, MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Streamdown } from 'streamdown'
import type { DocRef, DocRole, MapDecision, MapDetail, MapDocInfo, MapDocProposal } from '../../../shared/ipc'
import { isClosed } from '../../../shared/ipc'
import { externalLink } from '../lib/externalLink'
import { citingTickets, docCoverage, docMatches, headingLine, plainHeading, ROLE_LABEL, ROLE_ORDER, roleFilters, sectionLink, splitDoc } from '../lib/mapDocs'
import { decisionNumber, milestoneKey, ticketKey } from '../lib/mapStatus'
import { relativeDate } from '../lib/relativeDate'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Editor } from './Editor'
import { Chip } from './MapOverview'
import type { MapActions } from './MapView'
import { MultiSelect, type SelectOption } from './MultiSelect'
import { LINK_SAFETY } from './ThreadView'

const api = window.manta

const ROLE_OPTIONS: SelectOption[] = ROLE_ORDER.map((role) => ({ id: role, label: ROLE_LABEL[role] }))
const rolesOf = (ids: readonly string[]): DocRole[] => ROLE_ORDER.filter((role) => ids.includes(role))
const milestoneOptions = (map: MapDetail): SelectOption[] => map.milestones.map((m) => ({ id: m.id, key: milestoneKey(map, m), label: m.title }))

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

interface Point {
  x: number
  y: number
}

/** Below the clicked control, kept on screen; a keyboard press (no pointer) still has the control's box. */
function below(event: React.MouseEvent): Point {
  const rect = event.currentTarget instanceof Element ? event.currentTarget.getBoundingClientRect() : null
  return rect ? { x: rect.left, y: rect.bottom + 4 } : { x: event.clientX, y: event.clientY }
}

/**
 * A map's docs, as in the frame: the collection (search, role filters, a card per doc, what the
 * docs cover) beside a reader for the one picked. The reader shows the doc as it stands or with a
 * proposed change applied, its sections ready to attach to tickets, and the work and decisions
 * that cite it.
 */
export function MapDocs({ map, actions, selected, onSelect }: { map: MapDetail; actions: MapActions; selected: string | null; onSelect: (path: string | null) => void }): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [role, setRole] = useState<DocRole | null>(null)
  const [menu, setMenu] = useState<(Point & { items: MenuItem[] }) | null>(null)
  const [editing, setEditing] = useState<(Point & { path: string }) | null>(null)
  const [linking, setLinking] = useState<Point | null>(null)
  const filters = roleFilters(map.docs)
  const shown = map.docs.filter((d) => (role === null || d.roles.includes(role)) && docMatches(d, search))
  const doc = map.docs.find((d) => d.path === selected) ?? shown[0] ?? map.docs[0] ?? null
  const editingDoc = editing ? map.docs.find((d) => d.path === editing.path) : undefined

  const addMenu = (event: React.MouseEvent): void => {
    const at = below(event)
    setMenu({
      ...at,
      items: [
        { label: 'New doc…', icon: <FilePlus size={14} />, onSelect: () => actions.writeDoc(map.current ? [map.current.id] : []) },
        { label: 'Existing doc…', icon: <FileText size={14} />, onSelect: actions.addExistingDoc },
        { label: 'Link a design or prototype…', icon: <Link2 size={14} />, onSelect: () => setLinking(at) }
      ]
    })
  }

  const docMenu = (target: MapDocInfo, event: React.MouseEvent): void => {
    event.preventDefault()
    const at = event.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : below(event)
    setMenu({
      ...at,
      items: [
        { label: 'Edit details…', icon: <Pencil size={14} />, onSelect: () => setEditing({ ...at, path: target.path }) },
        ...(target.link
          ? [{ label: 'Open in the browser', icon: <ExternalLink size={14} />, onSelect: () => actions.openDoc(target.path) }]
          : target.exists
            ? [{ label: 'Open in the editor', icon: <FileText size={14} />, onSelect: () => actions.openDoc(target.path) }]
            : []),
        {
          label: 'Remove from map',
          icon: <Trash2 size={14} />,
          onSelect: () => void actions.editDocs({ kind: 'remove-doc', path: target.path }).then((ok) => ok && target.path === doc?.path && onSelect(null))
        }
      ]
    })
  }

  return (
    <div className="map-scroll">
      <div className="map-page map-dk-page">
        <header className="map-ov-head">
          <div className="map-ov-heading">
            <div className="map-ov-title">
              <h1>Docs</h1>
              <Chip tone="muted">{plural(map.docs.length, 'document')}</Chip>
            </div>
            <p className="map-ov-description">The shared knowledge behind every ticket, decision and agent session.</p>
          </div>
          <div className="map-ov-actions">
            <button className="map-button" onClick={addMenu}>
              <Plus size={13} /> Add document
            </button>
          </div>
        </header>

        <div className="map-dk-grid">
          <aside className="map-dk-list">
            <label className="map-dk-search">
              <Search size={14} />
              <input value={search} placeholder="Search documents" onChange={(e) => setSearch(e.target.value)} />
            </label>
            {filters.length > 0 && (
              <div className="map-dc-filters">
                <button className={`map-dc-filter ${role === null ? 'active' : ''}`} onClick={() => setRole(null)}>
                  All <span>{map.docs.length}</span>
                </button>
                {filters.map((r) => (
                  <button key={r} className={`map-dc-filter ${role === r ? 'active' : ''}`} onClick={() => setRole(role === r ? null : r)}>
                    {ROLE_LABEL[r]}
                  </button>
                ))}
              </div>
            )}
            <div className="map-dk-label">
              <span>In this map</span>
              <span>{shown.length}</span>
            </div>
            {map.docs.length === 0 && <div className="map-ov-empty">No docs on the map yet. Add one, or write a PRD from the Overview.</div>}
            {map.docs.length > 0 && shown.length === 0 && <div className="map-ov-empty">Nothing matches.</div>}
            {shown.map((d) => (
              <DocCard key={d.path} map={map} doc={d} selected={d.path === doc?.path} onSelect={() => onSelect(d.path)} onMenu={(e) => docMenu(d, e)} />
            ))}
            <Coverage docs={map.docs} onLink={(e) => setLinking(below(e))} />
            <p className="map-dk-footnote">Agents receive only the relevant sections, with links back to the source.</p>
          </aside>

          {doc ? (
            <DocReader key={doc.path} map={map} doc={doc} actions={actions} onMenu={(e) => docMenu(doc, e)} />
          ) : (
            <section className="map-card map-dk-reader">
              <div className="map-ov-empty">Add a doc to read it here.</div>
            </section>
          )}
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {editing && editingDoc && <DocDetails at={editing} map={map} doc={editingDoc} actions={actions} onClose={() => setEditing(null)} />}
      {linking && <LinkForm at={linking} map={map} actions={actions} onClose={() => setLinking(null)} onAdded={() => onSelect(null)} />}
    </div>
  )
}

function DocCard({ map, doc, selected, onSelect, onMenu }: { map: MapDetail; doc: MapDocInfo; selected: boolean; onSelect: () => void; onMenu: (event: React.MouseEvent) => void }): React.JSX.Element {
  const proposals = map.proposals.filter((p) => p.doc === doc.path).length
  const tickets = citingTickets(map, doc.path).length
  const meta = doc.link
    ? [externalLink(doc.link.url).where, 'Opens in the browser']
    : doc.exists
      ? [...(tickets > 0 ? [plural(tickets, 'linked ticket')] : []), ...(doc.updatedAt ? [`Updated ${relativeDate(doc.updatedAt)}`] : [])]
      : ['Not in the docs repo']
  const Icon = doc.link ? Link2 : doc.exists ? FileText : AlertTriangle
  return (
    <div
      role="button"
      tabIndex={0}
      className={`map-card map-dk-card ${selected ? 'selected' : ''}`}
      title={doc.link ? doc.link.url : doc.path}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        onSelect()
      }}
      onContextMenu={onMenu}
    >
      <div className="map-dk-card-top">
        <Icon size={15} className="map-dk-card-icon" />
        <span className={`map-dk-card-title ${doc.exists ? '' : 'missing'}`}>{doc.title}</span>
        <button className="icon-button map-dk-card-more" title="Edit, open or remove" onClick={(e) => (e.stopPropagation(), onMenu(e))}>
          <MoreHorizontal size={14} />
        </button>
      </div>
      {(doc.roles.length > 0 || proposals > 0) && (
        <div className="map-dk-card-chips">
          {doc.roles.map((r) => (
            <Chip key={r} tone="muted">
              {ROLE_LABEL[r]}
            </Chip>
          ))}
          {proposals > 0 && <Chip tone="you">{plural(proposals, 'proposed change')}</Chip>}
        </div>
      )}
      {meta.length > 0 && <div className="map-dk-card-meta">{meta.join(' · ')}</div>}
    </div>
  )
}

function Coverage({ docs, onLink }: { docs: readonly MapDocInfo[]; onLink: (event: React.MouseEvent) => void }): React.JSX.Element {
  return (
    <section className="map-card map-dk-coverage">
      <h2>Context coverage</h2>
      {docCoverage(docs).map((line) => (
        <div key={line.label} className={`map-dk-coverage-line ${line.covered ? 'covered' : ''}`} title={line.covered ? undefined : `No doc has the ${line.roles.map((r) => ROLE_LABEL[r]).join(' and ')} role yet`}>
          {line.covered ? <Check size={13} /> : <Circle size={11} />}
          {line.label}
        </div>
      ))}
      <button className="map-link map-dk-coverage-add" onClick={onLink}>
        <Plus size={11} /> Link a design or prototype
      </button>
    </section>
  )
}

/** Which text the reader shows: the doc as it stands, or with one proposal applied. */
type Version = { kind: 'accepted' } | { kind: 'proposal'; thread: string }

function DocReader({ map, doc, actions, onMenu }: { map: MapDetail; doc: MapDocInfo; actions: MapActions; onMenu: (event: React.MouseEvent) => void }): React.JSX.Element {
  const proposals = map.proposals.filter((p) => p.doc === doc.path)
  const [version, setVersion] = useState<Version>({ kind: 'accepted' })
  const [text, setText] = useState<string | null | undefined>(undefined)
  const [attach, setAttach] = useState<(Point & { ref: DocRef }) | null>(null)
  const [menu, setMenu] = useState<(Point & { items: MenuItem[] }) | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const shownThread = version.kind === 'proposal' && proposals.some((p) => p.thread === version.thread) ? version.thread : null

  const { docsRoot, report } = actions
  const isLink = Boolean(doc.link)
  /** The accepted version of a doc in the repo is edited in place; a proposal or a web link only reads. */
  const editing = !isLink && doc.exists && shownThread === null
  const [reveal, setReveal] = useState<{ line: number; seq: number } | undefined>(undefined)
  const editorError = useCallback((message: string) => report(new Error(message)), [report])

  /* `updatedAt` is a dependency so the text follows the file: it changes when the doc is saved. */
  useEffect(() => {
    if (isLink) return
    let live = true
    const load = shownThread ? api.threadProposal(docsRoot, doc.path, shownThread).then((p) => p.merged) : api.mapDocText(docsRoot, doc.path)
    load.then(
      (loaded) => live && setText(loaded),
      (e: unknown) => {
        if (live) setText(null)
        report(e)
      }
    )
    return () => {
      live = false
    }
  }, [docsRoot, report, doc.path, isLink, doc.updatedAt, shownThread])

  const parts = text ? splitDoc(text) : null
  const tickets = citingTickets(map, doc.path)
  const milestones = map.milestones.filter((m) => doc.milestones.includes(m.id))
  const decisions = map.decisions.filter((d) => d.docs.some((r) => r.path === doc.path)).sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open'))
  const pending = decisions.filter((d) => d.status === 'open')
  const sectionOf = (d: MapDecision): string | null => d.docs.find((r) => r.path === doc.path && r.heading && parts?.sections.some((s) => s.heading === r.heading))?.heading ?? null
  const label = [...doc.roles.map((r) => ROLE_LABEL[r]), ...(doc.section ? [map.sections.find((s) => s.id === doc.section)?.title ?? ''] : [])].filter(Boolean).join(' / ')
  const shownProposal = proposals.find((p) => p.thread === shownThread)

  const review = (event: React.MouseEvent): void => {
    const only = shownProposal ?? (proposals.length === 1 ? proposals[0] : undefined)
    if (only) return actions.openProposal(only)
    const at = below(event)
    setMenu({ x: Math.max(8, at.x - 120), y: at.y, items: proposals.map((p) => ({ label: p.title, icon: <ArrowRight size={14} />, onSelect: () => actions.openProposal(p) })) })
  }

  const copy = (heading: string): void => {
    void navigator.clipboard.writeText(sectionLink(doc.path, heading)).then(
      () => setCopied(heading),
      (e: unknown) => actions.report(e)
    )
  }

  const notices = (heading: string | null): React.JSX.Element[] =>
    pending
      .filter((d) => sectionOf(d) === heading)
      .map((d) => (
        <button key={d.id} className="map-dk-notice" onClick={() => actions.openDecision(d.id)}>
          {d.title} is pending in Decision {decisionNumber(d)}.
        </button>
      ))

  return (
    <section className="map-card map-dk-reader">
      <div className="map-dk-controls">
        {!doc.link && (
          <div className="map-dk-versions">
            <button className={`map-dc-filter ${shownThread === null ? 'active' : ''}`} onClick={() => setVersion({ kind: 'accepted' })}>
              Accepted version
            </button>
            {proposals.length === 1 && proposals[0] && (
              <button className={`map-dc-filter ${shownThread ? 'active' : ''}`} onClick={() => proposals[0] && setVersion({ kind: 'proposal', thread: proposals[0].thread })}>
                With the proposed change
              </button>
            )}
            {proposals.length > 1 && (
              <select className={`map-select-field small map-dk-version-pick ${shownThread ? 'active' : ''}`} value={shownThread ?? ''} onChange={(e) => setVersion(e.target.value ? { kind: 'proposal', thread: e.target.value } : { kind: 'accepted' })}>
                <option value="">With a proposed change…</option>
                {proposals.map((p) => (
                  <option key={p.thread} value={p.thread}>
                    {p.title}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
        <span className="grow" />
        {doc.link && (
          <button className="map-button" onClick={() => actions.openDoc(doc.path)}>
            <ExternalLink size={13} /> Open in the browser
          </button>
        )}
        <button className="map-button" onClick={() => actions.askAbout(`About “${doc.title}”: `)}>
          Ask about this
        </button>
        <button className="map-button" disabled={!doc.exists || Boolean(doc.link)} title={doc.link ? 'Agents can’t open web links; attach a doc instead' : undefined} onClick={(e) => setAttach({ ...below(e), ref: { path: doc.path, heading: null } })}>
          Attach to ticket
        </button>
        <button className="icon-button" title="Open in the editor, edit details, or remove from the map" onClick={onMenu}>
          <MoreHorizontal size={14} />
        </button>
      </div>

      {proposals.length > 0 && (
        <ProposalBanner proposals={proposals} shown={shownProposal ?? null} onReview={review} />
      )}

      <div className="map-dk-body">
        <article className="map-dk-article">
          {label && <div className="map-dk-kind">{label}</div>}
          {!editing && <h1 className="map-dk-title">{doc.title}</h1>}
          <div className="map-dk-meta">
            {[map.title, ...(doc.updatedAt ? [`Updated ${relativeDate(doc.updatedAt)}`] : []), doc.link ? doc.link.url : shownProposal ? `With “${shownProposal.title}” applied, not approved` : doc.path].join(' · ')}
          </div>
          {editing ? (
            <>
              {pending.map((d) => (
                <button key={d.id} className="map-dk-notice" onClick={() => actions.openDecision(d.id)}>
                  {d.title} is pending in Decision {decisionNumber(d)}.
                </button>
              ))}
              <div className="map-dk-editor">
                <Editor key={doc.path} root={docsRoot} relPath={doc.path} mode="doc" visible embedded revealLine={reveal} onError={editorError} />
              </div>
            </>
          ) : doc.link ? (
            <div className="map-dk-text">
              <p>
                A web page on the map. Open it in the browser; agents see its title and address in the map’s outline, not its contents.
              </p>
            </div>
          ) : !doc.exists ? (
            <div className="map-ov-empty">{doc.path} isn’t in the docs repo. Remove it from the map, or create it again.</div>
          ) : text === undefined ? (
            <div className="map-ov-empty">Loading…</div>
          ) : parts === null ? (
            <div className="map-ov-empty">The doc is empty.</div>
          ) : (
            <>
              {parts.intro && (
                <div className="map-dk-text">
                  <Streamdown controls={false} linkSafety={LINK_SAFETY}>
                    {parts.intro}
                  </Streamdown>
                </div>
              )}
              {notices(null)}
              {parts.sections.map((section, index) => (
                <div key={`${section.heading}-${index}`} className="map-dk-section" id={sectionId(section.heading, index)}>
                  <div className="map-dk-section-head">
                    <h2>{plainHeading(section.heading)}</h2>
                    <button className="map-link map-dk-copy" title="Copy a markdown link to this section" onClick={() => copy(section.heading)}>
                      § {copied === section.heading ? 'Copied' : 'Copy link'}
                    </button>
                  </div>
                  {section.body && (
                    <div className="map-dk-text">
                      <Streamdown controls={false} linkSafety={LINK_SAFETY}>
                        {section.body}
                      </Streamdown>
                    </div>
                  )}
                  {notices(section.heading)}
                  <button className="map-link map-dk-attach" onClick={(e) => setAttach({ ...below(e), ref: { path: doc.path, heading: section.heading } })}>
                    Attach this section to a ticket <ArrowRight size={11} />
                  </button>
                </div>
              ))}
            </>
          )}
        </article>

        <aside className="map-dk-rail">
          {parts && parts.sections.length > 0 && (
            <div className="map-dk-rail-block">
              <div className="map-dk-rail-label">On this page</div>
              {parts.sections.map((section, index) => (
                <div key={`${section.heading}-${index}`} className="map-dk-rail-row">
                  <button
                    className="map-dk-rail-link"
                    onClick={() => {
                      if (!editing) return document.getElementById(sectionId(section.heading, index))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      const line = headingLine(text ?? '', section.heading, index)
                      if (line !== null) setReveal((last) => ({ line, seq: (last?.seq ?? 0) + 1 }))
                    }}
                  >
                    {plainHeading(section.heading)}
                  </button>
                  {editing && (
                    <span className="map-dk-rail-actions">
                      <button className="icon-button" title={copied === section.heading ? 'Copied' : 'Copy a markdown link to this section'} onClick={() => copy(section.heading)}>
                        {copied === section.heading ? <Check size={12} /> : <Link2 size={12} />}
                      </button>
                      <button className="icon-button" title="Attach this section to a ticket" onClick={(e) => setAttach({ ...below(e), ref: { path: doc.path, heading: section.heading } })}>
                        <Plus size={12} />
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="map-dk-rail-block">
            <div className="map-dk-rail-label">Connected work</div>
            {milestones.length + tickets.length === 0 && <div className="map-dk-rail-empty">No milestone or ticket cites it yet.</div>}
            {milestones.map((m) => (
              <button key={m.id} className="map-dk-rail-item" onClick={() => actions.openMilestone(m.id)}>
                <span className="map-key">{milestoneKey(map, m)}</span>
                <span>{m.title}</span>
              </button>
            ))}
            {tickets.map((t) => (
              <button key={t.id} className="map-dk-rail-item" onClick={() => actions.openTicket(t)}>
                <span className="map-key">{ticketKey(map, t)}</span>
                <span>{t.title}</span>
              </button>
            ))}
          </div>
          {decisions.map((d) => (
            <div key={d.id} className="map-dk-rail-block">
              <div className="map-dk-rail-label">Decision {decisionNumber(d)}</div>
              <div className="map-dk-rail-decision">{d.title}</div>
              <div className="map-dk-rail-empty">{d.status === 'open' ? 'Open' : d.status === 'superseded' ? 'Superseded' : 'Decided'}</div>
              <button className="map-link" onClick={() => actions.openDecision(d.id)}>
                View decision <ArrowRight size={11} />
              </button>
            </div>
          ))}
        </aside>
      </div>
      {attach && <AttachPicker at={attach} map={map} doc={attach.ref} actions={actions} onClose={() => setAttach(null)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </section>
  )
}

function sectionId(heading: string, index: number): string {
  return `map-dk-section-${index}-${heading.length}`
}

function ProposalBanner({ proposals, shown, onReview }: { proposals: readonly MapDocProposal[]; shown: MapDocProposal | null; onReview: (event: React.MouseEvent) => void }): React.JSX.Element {
  const sessions = new Set(proposals.map((p) => ('launch' in p.from ? p.from.launch : 'sweep' in p.from ? p.from.sweep : 'ask'))).size
  return (
    <div className="map-dk-banner">
      <div className="map-dk-banner-text">
        <strong>{plural(proposals.length, 'proposed change')}</strong>
        <span>{shown ? `Showing “${shown.title}” applied · Not approved yet` : `From ${plural(sessions, 'agent session')} · Not applied to this version`}</span>
      </div>
      <button className="map-button primary" onClick={onReview}>
        Review changes <ArrowRight size={13} />
      </button>
    </div>
  )
}

/** Tickets not done, by milestone, to attach a doc or a section to; a tick for those that have it. */
function AttachPicker({ at, map, doc, actions, onClose }: { at: Point; map: MapDetail; doc: DocRef; actions: MapActions; onClose: () => void }): React.JSX.Element {
  const has = (docs: readonly DocRef[]): boolean => docs.some((d) => d.path === doc.path && d.heading === doc.heading)
  const tickets = map.milestones.flatMap((m) => m.tickets.filter((t) => !isClosed(t.status)).map((ticket) => ({ milestone: m, ticket })))
  const options: SelectOption[] = tickets.map(({ milestone, ticket }) => ({ id: ticket.id, key: ticketKey(map, ticket), label: ticket.title, group: `${milestoneKey(map, milestone)} · ${milestone.title}` }))
  const attached = tickets.filter(({ ticket }) => has(ticket.docs)).map(({ ticket }) => ticket.id)
  const attach = (ids: string[]): void => {
    for (const { ticket } of tickets) {
      const on = ids.includes(ticket.id)
      if (on === has(ticket.docs)) continue
      void actions.edit({ kind: 'update-ticket', ticket: ticket.id, docs: on ? [...ticket.docs, doc] : ticket.docs.filter((d) => !(d.path === doc.path && d.heading === doc.heading)) })
    }
  }
  return (
    <div className="dialog-backdrop transparent" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="map-launch-popover map-dk-popover" style={{ left: Math.min(at.x, window.innerWidth - 320), top: Math.min(at.y, window.innerHeight - 340) }} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="map-launch-title">Attach {doc.heading ? `“${plainHeading(doc.heading)}”` : 'the whole doc'} to</div>
        {tickets.length === 0 ? (
          <div className="muted-row">No open tickets.</div>
        ) : (
          <MultiSelect options={options} value={attached} onChange={attach} placeholder="No tickets" />
        )}
        <div className="map-launch-actions">
          <span />
          <button className="map-button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

/** Everything about a doc on the map: a link's title and address, its roles, milestones and section. */
function DocDetails({ at, map, doc, actions, onClose }: { at: Point; map: MapDetail; doc: MapDocInfo; actions: MapActions; onClose: () => void }): React.JSX.Element {
  const [link, setLink] = useState(doc.link ?? null)
  const [section, setSection] = useState<{ kind: 'new' | 'rename'; title: string } | null>(null)
  const current = map.sections.find((s) => s.id === doc.section) ?? null
  const update = (patch: { roles?: DocRole[]; milestones?: string[]; section?: string | null }): void => void actions.editDocs({ kind: 'update-doc', path: doc.path, ...patch })

  const saveSection = (): void => {
    const title = section?.title.trim()
    if (!section || !title) return setSection(null)
    if (section.kind === 'new') void actions.editDocs({ kind: 'add-section', title, doc: doc.path })
    else if (current) void actions.editDocs({ kind: 'rename-section', section: current.id, title })
    setSection(null)
  }

  return (
    <div className="dialog-backdrop transparent" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="map-launch-popover map-dk-popover" style={{ left: Math.min(at.x, window.innerWidth - 320), top: Math.min(at.y, window.innerHeight - 480) }} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="map-launch-title">{doc.title}</div>
        {link && (
          <form
            className="map-dk-form"
            onSubmit={(e) => {
              e.preventDefault()
              void actions.editDocs({ kind: 'update-doc', path: doc.path, link })
            }}
          >
            <input className="map-select-field" value={link.title} placeholder="Title" onChange={(e) => setLink({ ...link, title: e.target.value })} />
            <input className="map-select-field" value={link.url} placeholder="https://…" onChange={(e) => setLink({ ...link, url: e.target.value })} />
            <button type="submit" className="map-button" disabled={link.title === doc.link?.title && link.url === doc.link.url}>
              Save link
            </button>
          </form>
        )}
        <div className="map-dk-rail-label">Roles</div>
        <MultiSelect options={ROLE_OPTIONS} value={doc.roles} onChange={(ids) => update({ roles: rolesOf(ids) })} placeholder="No roles" />
        <div className="map-dk-rail-label">Milestones</div>
        {map.milestones.length === 0 ? (
          <div className="muted-row">No milestones yet.</div>
        ) : (
          <MultiSelect options={milestoneOptions(map)} value={doc.milestones} onChange={(ids) => update({ milestones: ids })} placeholder="No milestone" />
        )}
        <div className="map-dk-rail-label">Section</div>
        {section ? (
          <form
            className="map-dk-form"
            onSubmit={(e) => {
              e.preventDefault()
              saveSection()
            }}
          >
            <input autoFocus className="map-select-field" value={section.title} placeholder="Section name, e.g. Runbooks" onChange={(e) => setSection({ ...section, title: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setSection(null))} />
            <button type="submit" className="map-button" disabled={!section.title.trim()}>
              {section.kind === 'new' ? 'Add' : 'Rename'}
            </button>
          </form>
        ) : (
          <div className="map-dk-form row">
            <select className="map-select-field" value={doc.section ?? ''} onChange={(e) => (e.target.value === '+' ? setSection({ kind: 'new', title: '' }) : update({ section: e.target.value || null }))}>
              <option value="">None</option>
              {map.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
              <option value="+">New section…</option>
            </select>
            {current && (
              <>
                <button className="icon-button" title={`Rename ${current.title}`} onClick={() => setSection({ kind: 'rename', title: current.title })}>
                  <Pencil size={12} />
                </button>
                <button className="icon-button" title={`Remove ${current.title}; its docs stay on the map`} onClick={() => void actions.editDocs({ kind: 'remove-section', section: current.id })}>
                  <Trash2 size={12} />
                </button>
              </>
            )}
          </div>
        )}
        <div className="map-launch-actions">
          <span />
          <button className="map-button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

/** Adds a web page (a design, a prototype) to the map as a doc. */
function LinkForm({ at, map, actions, onClose, onAdded }: { at: Point; map: MapDetail; actions: MapActions; onClose: () => void; onAdded: () => void }): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [roles, setRoles] = useState<DocRole[]>(['design'])
  return (
    <div className="dialog-backdrop transparent" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="map-launch-popover map-dk-popover"
        style={{ left: Math.min(at.x, window.innerWidth - 320), top: Math.min(at.y, window.innerHeight - 320) }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={(e) => {
          e.preventDefault()
          void actions.editDocs({ kind: 'add-link', url, title, roles, milestones: map.current ? [map.current.id] : [] }).then((ok) => {
            if (!ok) return
            onAdded()
            onClose()
          })
        }}
      >
        <div className="map-launch-title">Link a design or prototype</div>
        <div className="map-dk-form">
          <input autoFocus className="map-select-field" value={title} placeholder="Title, e.g. Login flow" onChange={(e) => setTitle(e.target.value)} />
          <input className="map-select-field" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
        </div>
        <MultiSelect options={ROLE_OPTIONS} value={roles} onChange={(ids) => setRoles(rolesOf(ids))} placeholder="No roles" />
        <div className="map-launch-actions">
          <button type="button" className="map-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="map-button" disabled={!title.trim() || !url.trim()}>
            Add link
          </button>
        </div>
      </form>
    </div>
  )
}
