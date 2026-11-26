import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

/** How close the pointer must come to an edge for its scrollbar to appear, in pixels. */
const NEAR = 24
/** How long a scrollbar stays after the last scroll, in ms. */
const LINGER = 900
const MIN_THUMB = 28

type Axis = 'x' | 'y'

/** One thumb's size and offset along its track, for a scroller of `view` px showing `content` px at `scroll`. */
export function thumbGeometry(view: number, content: number, scroll: number): { size: number; offset: number } | null {
  if (content <= view + 1 || view <= 0) return null
  const size = Math.min(view, Math.max(MIN_THUMB, (view * view) / content))
  const travel = content - view
  const offset = travel > 0 ? Math.min(1, Math.max(0, scroll / travel)) * (view - size) : 0
  return { size, offset }
}

class OverlayScrollbars {
  private readonly thumbs: Record<Axis, HTMLElement> = { x: document.createElement('div'), y: document.createElement('div') }
  private readonly resize: ResizeObserver
  private timer: number | undefined
  private near: Record<Axis, boolean> = { x: false, y: false }
  private dragging: Axis | null = null

  private readonly onScroll = (): void => {
    this.render()
    this.linger()
  }

  private readonly onMove = (event: MouseEvent): void => {
    const box = this.view.scrollDOM.getBoundingClientRect()
    const near = { y: box.right - event.clientX <= NEAR, x: box.bottom - event.clientY <= NEAR }
    if (near.x !== this.near.x || near.y !== this.near.y) {
      this.near = near
      this.render()
    }
  }

  private readonly onLeave = (): void => {
    this.near = { x: false, y: false }
    this.render()
  }

  constructor(private readonly view: EditorView) {
    for (const axis of ['x', 'y'] as const) {
      const thumb = this.thumbs[axis]
      thumb.className = `cm-overlay-scrollbar ${axis}`
      thumb.addEventListener('mousedown', (event) => this.startDrag(axis, event))
      view.dom.appendChild(thumb)
    }
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
    view.dom.addEventListener('mousemove', this.onMove)
    view.dom.addEventListener('mouseleave', this.onLeave)
    this.resize = new ResizeObserver(() => this.render())
    this.resize.observe(view.scrollDOM)
    this.resize.observe(view.contentDOM)
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.geometryChanged) this.render()
  }

  destroy(): void {
    window.clearTimeout(this.timer)
    this.resize.disconnect()
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
    this.view.dom.removeEventListener('mousemove', this.onMove)
    this.view.dom.removeEventListener('mouseleave', this.onLeave)
    for (const thumb of Object.values(this.thumbs)) thumb.remove()
  }

  private lingering = false

  private linger(): void {
    this.lingering = true
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.lingering = false
      this.render()
    }, LINGER)
  }

  private render(): void {
    const s = this.view.scrollDOM
    const y = thumbGeometry(s.clientHeight, s.scrollHeight, s.scrollTop)
    const x = thumbGeometry(s.clientWidth, s.scrollWidth, s.scrollLeft)
    const place = (axis: Axis, geometry: { size: number; offset: number } | null): void => {
      const thumb = this.thumbs[axis]
      const shown = geometry !== null && (this.near[axis] || this.lingering || this.dragging === axis)
      thumb.classList.toggle('visible', shown)
      if (!geometry) return
      const [length, offset] = axis === 'y' ? ['height', 'top'] : ['width', 'left']
      thumb.style.setProperty(length, `${geometry.size}px`)
      thumb.style.setProperty(offset, `${geometry.offset}px`)
    }
    place('y', y)
    place('x', x)
  }

  private startDrag(axis: Axis, event: MouseEvent): void {
    event.preventDefault()
    const s = this.view.scrollDOM
    const vertical = axis === 'y'
    const start = vertical ? event.clientY : event.clientX
    const from = vertical ? s.scrollTop : s.scrollLeft
    const geometry = vertical ? thumbGeometry(s.clientHeight, s.scrollHeight, s.scrollTop) : thumbGeometry(s.clientWidth, s.scrollWidth, s.scrollLeft)
    if (!geometry) return
    const track = (vertical ? s.clientHeight : s.clientWidth) - geometry.size
    const travel = (vertical ? s.scrollHeight - s.clientHeight : s.scrollWidth - s.clientWidth) / Math.max(1, track)
    this.dragging = axis
    const move = (e: MouseEvent): void => {
      const target = from + ((vertical ? e.clientY : e.clientX) - start) * travel
      if (vertical) s.scrollTop = target
      else s.scrollLeft = target
    }
    const up = (): void => {
      this.dragging = null
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      this.render()
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    this.render()
  }
}

/**
 * Scrollbars drawn over the editor instead of beside it: the native ones are hidden (`.cm-scroller` in
 * the stylesheet) so they take no room, and a thin thumb fades in while scrolling or when the pointer is
 * near the right or bottom edge.
 */
export const overlayScrollbars = ViewPlugin.fromClass(OverlayScrollbars)
