import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { FileText, Map as MapIcon, RotateCcw } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { MapLink, TerminalInfo, TerminalLink } from '../../../shared/ipc'
import { onThemeChange } from '../lib/editorTheme'
import { onTerminalOutput } from '../lib/terminalData'
import { cellSize, fitSize } from '../lib/terminalFit'
import { editKey } from '../lib/terminalKeys'
import { stateLabel } from '../lib/terminalStatus'
import { HiddenWebglBudget } from '../lib/webglBudget'

const api = window.manta

/** 6 hidden plus the visible terminals stay under Chromium's 16 WebGL contexts per page. */
const hiddenWebgl = new HiddenWebglBudget(6)
/** Gives up a hidden terminal's WebGL context, by terminal id. */
const releaseWebgl = new Map<string, () => void>()

interface MountedTerminal {
  term: Terminal
  fit: FitAddon
  webgl: WebglAddon | null
  /** Creating a WebGL renderer threw (no GPU): stay on the DOM renderer instead of retrying on every show. */
  webglFailed: boolean
}

export interface TerminalViewProps {
  info: TerminalInfo
  /** Its tab is the active one; hidden tabs can't be measured, so they fit when shown. */
  visible: boolean
  onError: (message: string) => void
  /** Opens the doc an implementation session was started from. */
  onOpenLink: (link: TerminalLink) => void
  /** Opens the context map a session was started from. */
  onOpenMap: (link: MapLink) => void
  /** A hyperlink the program printed (OSC 8) was clicked: its text can hide where it goes, so the parent asks first. */
  onOpenUrl: (url: string) => void
  /** The title of the map a session was started from, for its bar. */
  mapTitle?: string | undefined
}

/**
 * Draws with WebGL, much cheaper than the DOM renderer for a busy terminal. When the GPU drops the
 * context (sleep, a driver reset) the addon is disposed and xterm goes back to DOM until the terminal
 * is next shown. `data-renderer` on the screen says which one draws.
 */
function attachWebgl(mounted: MountedTerminal, screen: HTMLElement): void {
  if (mounted.webgl || mounted.webglFailed) return
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => detachWebgl(mounted, screen))
    mounted.term.loadAddon(webgl)
    mounted.webgl = webgl
    screen.dataset.renderer = 'webgl'
  } catch (error) {
    mounted.webglFailed = true
    console.warn('manta: WebGL terminal renderer unavailable, using DOM', error)
  }
}

function detachWebgl(mounted: MountedTerminal, screen: HTMLElement): void {
  mounted.webgl?.dispose()
  mounted.webgl = null
  screen.dataset.renderer = 'dom'
  /** The DOM renderer's cells can be taller than WebGL's, and the container didn't resize to say so. */
  refit(mounted, screen)
}

/**
 * Sets rows and columns from the container's size and the current cell size. The resize observer only
 * sees the container change, so anything that changes the cell size alone (a renderer switch, a web font
 * arriving, a different display's pixel ratio) must call this, or the rows drawn no longer match the box.
 */
function refit(mounted: MountedTerminal, screen: HTMLElement): void {
  if (screen.clientWidth > 0 && screen.clientHeight > 0) fitTerminal(mounted, screen)
}

/**
 * Counts the rows and columns that fit the screen's content box, from xterm's cell size (`cellSize`).
 * `FitAddon.fit()` gets both wrong here: it reads the parent's computed height, which under
 * `box-sizing: border-box` includes the screen's padding, so it usually proposes one row too many and the
 * last row slides under the footer; and it keeps 14 px free for a scrollbar that floats over the text.
 * The addon's proposal is only a fallback, should xterm's render state ever move.
 */
function fitTerminal({ term, fit }: MountedTerminal, screen: HTMLElement): void {
  const cell = cellSize(term)
  const style = getComputedStyle(screen)
  const width = screen.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  const height = screen.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
  const size = cell ? fitSize(width, height, cell) : fit.proposeDimensions()
  if (size && (size.cols !== term.cols || size.rows !== term.rows)) term.resize(size.cols, size.rows)
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const ANSI_COLORS = [
  ['black', 'brightBlack'],
  ['red', 'brightRed'],
  ['green', 'brightGreen'],
  ['yellow', 'brightYellow'],
  ['blue', 'brightBlue'],
  ['magenta', 'brightMagenta'],
  ['cyan', 'brightCyan'],
  ['white', 'brightWhite']
] as const

/** The app's colours, or a built-in theme's `--term-*` palette; ANSI colours left unset keep xterm's. */
function theme(): ITheme {
  const ansi: ITheme = {}
  for (const [normal, bright] of ANSI_COLORS) {
    const normalColor = cssVar(`--term-${normal}`)
    const brightColor = cssVar(`--term-bright-${normal}`)
    if (normalColor) ansi[normal] = normalColor
    if (brightColor) ansi[bright] = brightColor
  }
  return {
    ...ansi,
    background: cssVar('--term-bg') || cssVar('--bg'),
    foreground: cssVar('--term-fg') || cssVar('--text'),
    cursor: cssVar('--term-cursor') || cssVar('--accent'),
    cursorAccent: cssVar('--term-cursor-accent') || cssVar('--bg'),
    selectionBackground: cssVar('--term-selection') || cssVar('--bg-active')
  }
}

/**
 * One terminal's screen. Mounts with main's snapshot, then applies only output newer than it, so
 * switching away and back (or reloading the window) shows exactly what ran meanwhile. The parent
 * keys it by `startedAt`, so a restart mounts a fresh screen.
 */
export function TerminalView({ info, visible, onError, onOpenLink, onOpenMap, onOpenUrl, mapTitle }: TerminalViewProps): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const view = useRef<MountedTerminal | null>(null)
  const errorRef = useRef(onError)
  errorRef.current = onError
  const openUrlRef = useRef(onOpenUrl)
  openUrlRef.current = onOpenUrl
  const { id, kind } = info

  useEffect(() => {
    const element = container.current
    if (!element) return
    const term = new Terminal({
      fontFamily: cssVar('--font-mono'),
      fontSize: 12.5,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme: theme(),
      /** xterm's default asks with `confirm()` and then opens a blank window, which main's window-open handler refuses. */
      linkHandler: { activate: (_event, text) => openUrlRef.current(text) }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    /** `window.open` reaches main's window-open handler, which opens http(s) links in the browser. */
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)))
    term.open(element)
    /** Editing shortcuts sent the way every shell's line editor reads them; the browser's own text editing never runs. */
    term.attachCustomKeyEventHandler((event) => {
      const data = editKey(event, kind)
      if (data === null) return true
      event.preventDefault()
      api.writeTerminal(id, data)
      return false
    })
    const mounted: MountedTerminal = { term, fit, webgl: null, webglFailed: false }
    /** No fit here: `onResize` isn't listening yet, so the pty would never hear of the new size. The resize observer fits first. */
    attachWebgl(mounted, element)
    view.current = mounted
    releaseWebgl.set(id, () => detachWebgl(mounted, element))

    let lastSeq = 0
    let pending: { data: string; seq: number }[] | null = []
    const apply = (data: string, seq: number): void => {
      if (seq <= lastSeq) return
      term.write(data)
      lastSeq = seq
    }
    const stopData = onTerminalOutput(id, (data, seq) => {
      if (pending) pending.push({ data, seq })
      else apply(data, seq)
    })
    api
      .terminalSnapshot(id)
      .then((snapshot) => {
        term.write(snapshot.data)
        lastSeq = snapshot.seq
        for (const chunk of pending ?? []) apply(chunk.data, chunk.seq)
        pending = null
      })
      .catch((error: unknown) => errorRef.current(error instanceof Error ? error.message : String(error)))

    const input = term.onData((data) => api.writeTerminal(id, data))
    const resize = term.onResize(({ cols, rows }) => api.resizeTerminal(id, cols, rows))
    const observer = new ResizeObserver(() => {
      refit(mounted, element)
    })
    observer.observe(element)
    void document.fonts.ready.then(() => refit(mounted, element))
    /** A different display's pixel ratio changes the cell size too. */
    const pixelRatio = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const onPixelRatio = (): void => refit(mounted, element)
    pixelRatio.addEventListener('change', onPixelRatio)
    const stopTheme = onThemeChange(() => {
      term.options.theme = theme()
    })
    return () => {
      stopTheme()
      pixelRatio.removeEventListener('change', onPixelRatio)
      observer.disconnect()
      stopData()
      input.dispose()
      resize.dispose()
      term.dispose()
      view.current = null
      releaseWebgl.delete(id)
      hiddenWebgl.forget(id)
    }
  }, [id, kind, info.startedAt])

  /** xterm stops drawing a terminal that isn't visible and repaints it in full when it is again. */
  useEffect(() => {
    const mounted = view.current
    const element = container.current
    if (!mounted || !element) return
    mounted.term.options.cursorBlink = visible
    if (!visible) {
      if (mounted.webgl) for (const evicted of hiddenWebgl.hide(id)) releaseWebgl.get(evicted)?.()
      return
    }
    hiddenWebgl.forget(id)
    attachWebgl(mounted, element)
    refit(mounted, element)
    mounted.term.focus()
  }, [visible, id])

  const restart = (): void => {
    const term = view.current?.term
    api.restartTerminal(id, term?.cols ?? 120, term?.rows ?? 32).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
  }

  return (
    <div className="terminal-view" data-terminal={id}>
      {info.link && (
        <div className="terminal-link">
          <span>Implementing</span>
          <button className="link-button" title="Open the doc this session implements" onClick={() => info.link && onOpenLink(info.link)}>
            <FileText size={12} /> {info.link.doc}
          </button>
        </div>
      )}
      {info.map && (
        <div className="terminal-link">
          <span>From the context map</span>
          <button className="link-button" title="Open the map this session was started from" onClick={() => info.map && onOpenMap(info.map)}>
            <MapIcon size={12} /> {mapTitle ?? info.title}
          </button>
        </div>
      )}
      <div className="terminal-screen" ref={container} />
      {info.state === 'exited' && (
        <div className="terminal-exited">
          <span>{stateLabel(info)}</span>
          <button className="primary-button" onClick={restart}>
            <RotateCcw size={13} />
            {info.kind === 'shell' ? 'Restart shell' : info.resumable ? 'Resume session' : 'Start a new session'}
          </button>
        </div>
      )}
    </div>
  )
}
