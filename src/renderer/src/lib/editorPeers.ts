type Listener = (update: Uint8Array) => void

const peers = new Map<string, Set<Listener>>()

/**
 * Links the editors open on one file in this window. Main never sends an editor's own updates back
 * to the renderer, so a second editor on the same doc (a doc tab and the map's Docs page) would
 * otherwise miss the first one's typing until it reloads.
 */
export function joinPeers(key: string, onUpdate: Listener): { share: (update: Uint8Array) => void; leave: () => void } {
  const group = peers.get(key) ?? new Set<Listener>()
  peers.set(key, group)
  group.add(onUpdate)
  return {
    share: (update) => {
      for (const listener of group) if (listener !== onUpdate) listener(update)
    },
    leave: () => {
      group.delete(onUpdate)
      if (group.size === 0 && peers.get(key) === group) peers.delete(key)
    }
  }
}
