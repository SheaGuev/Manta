/// <reference types="vite/client" />
import type { MantaApi } from '../../shared/ipc'

declare global {
  interface Window {
    manta: MantaApi
  }
}

declare module 'react' {
  interface CSSProperties {
    /** Nesting level of a file tree row. */
    '--depth'?: number
    /** Horizontal offset of a tree level's indent guide. */
    '--guide'?: string
    '--sidebar-width'?: string
    '--panel-width'?: string
    /** How many lines a clamped block shows before More. */
    '--lines'?: number
  }
}
