import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { fuzzyMatch } from '../lib/search'

export interface SelectOption {
  id: string
  label: string
  /** A short code shown before the label and searched with it: `M4`, `OMN-18`. */
  key?: string
  /** A heading the option is listed under, e.g. its milestone. */
  group?: string
}

interface MultiSelectProps {
  options: readonly SelectOption[]
  value: readonly string[]
  onChange: (ids: string[]) => void
  /** The trigger's text when nothing is picked. */
  placeholder?: string
  /** One at a time: picking replaces the choice and closes the list. */
  single?: boolean
  disabled?: boolean
  className?: string
}

const WIDTH = 300
const ROOM_BELOW = 300

/**
 * A dropdown that picks any number of options: the trigger shows the picks, the list filters as you
 * type, and each row toggles. Fixed-positioned from the trigger, so a scrolling popover or dialog
 * around it never clips the list.
 */
export function MultiSelect({ options, value, onChange, placeholder = 'None', single, disabled, className }: MultiSelectProps): React.JSX.Element {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const picked = value.flatMap((id) => options.find((o) => o.id === id) ?? [])

  const toggle = (id: string): void => {
    if (single) {
      onChange(value.includes(id) ? [] : [id])
      setRect(null)
    } else onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`map-select-trigger ${className ?? ''}`}
        disabled={disabled}
        onClick={() => setRect((open) => (open ? null : (trigger.current?.getBoundingClientRect() ?? null)))}
      >
        <span className="map-select-picks">
          {picked.length === 0 ? (
            <span className="map-select-placeholder">{placeholder}</span>
          ) : (
            picked.map((option) => (
              <span key={option.id} className="map-select-chip">
                {option.key && <span className="map-key">{option.key}</span>}
                {option.label}
              </span>
            ))
          )}
        </span>
        <ChevronDown size={12} className="map-select-chevron" />
      </button>
      {rect && <OptionList options={options} value={value} rect={rect} onToggle={toggle} onClose={() => setRect(null)} trigger={trigger} />}
    </>
  )
}

function OptionList(props: {
  options: readonly SelectOption[]
  value: readonly string[]
  rect: DOMRect
  onToggle: (id: string) => void
  onClose: () => void
  trigger: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const { options, value, rect, onToggle, onClose, trigger } = props
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const popover = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return
      if (popover.current?.contains(event.target) || trigger.current?.contains(event.target)) return
      onClose()
    }
    document.addEventListener('mousedown', close)
    return () => {
      document.removeEventListener('mousedown', close)
    }
  }, [onClose, trigger])

  const shown = query
    ? options
        .flatMap((option) => {
          const match = fuzzyMatch(`${option.key ?? ''} ${option.label}`, query)
          return match ? [{ option, score: match.score }] : []
        })
        .sort((a, b) => b.score - a.score)
        .map(({ option }) => option)
    : options
  const at = Math.min(selected, Math.max(0, shown.length - 1))

  useEffect(() => {
    list.current?.querySelector('.quick-open-row.selected')?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') onClose()
    else if (event.key === 'ArrowDown') setSelected(Math.min(at + 1, shown.length - 1))
    else if (event.key === 'ArrowUp') setSelected(Math.max(at - 1, 0))
    else if (event.key === 'Enter') {
      const option = shown[at]
      if (option) onToggle(option.id)
    } else return
    /** Escape and Enter belong to the list, not to a dialog or form around it. */
    event.preventDefault()
    event.stopPropagation()
  }

  const width = Math.max(WIDTH, rect.width)
  const left = Math.min(rect.left, window.innerWidth - width - 8)
  const below = window.innerHeight - rect.bottom >= ROOM_BELOW
  const position: React.CSSProperties = below ? { top: rect.bottom + 4, left, width } : { bottom: window.innerHeight - rect.top + 4, left, width }

  return (
    <div ref={popover} className="popover quick-open map-select-popover" style={position} onKeyDown={onKeyDown}>
      <input
        autoFocus
        spellCheck={false}
        value={query}
        placeholder="Search…"
        onChange={(e) => {
          setQuery(e.target.value)
          setSelected(0)
        }}
      />
      <div className="quick-open-list" ref={list}>
        {shown.length === 0 && <p className="muted-row">Nothing matches</p>}
        {shown.map((option, index) => (
          <div key={option.id}>
            {!query && option.group && option.group !== shown[index - 1]?.group && <div className="map-select-group">{option.group}</div>}
            <div
              className={`quick-open-row map-select-row ${index === at ? 'selected' : ''}`}
              onMouseMove={() => setSelected(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onToggle(option.id)}
            >
              {option.key && <span className="map-key">{option.key}</span>}
              <span className="map-select-label">{option.label}</span>
              {value.includes(option.id) && <Check size={13} className="map-select-check" />}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
