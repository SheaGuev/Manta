type OutputListener = (data: string, seq: number) => void

const listeners = new Map<string, Set<OutputListener>>()
let subscribed = false

/**
 * A terminal's output from main. Every terminal shares one IPC listener that hands each chunk to its
 * own terminal's views, instead of each view seeing (and dropping) every other terminal's output.
 */
export function onTerminalOutput(id: string, listener: OutputListener): () => void {
  if (!subscribed) {
    subscribed = true
    window.manta.onTerminalData((terminal, data, seq) => {
      for (const forTerminal of listeners.get(terminal) ?? []) forTerminal(data, seq)
    })
  }
  const forId = listeners.get(id) ?? new Set<OutputListener>()
  forId.add(listener)
  listeners.set(id, forId)
  return () => {
    forId.delete(listener)
    if (forId.size === 0) listeners.delete(id)
  }
}
