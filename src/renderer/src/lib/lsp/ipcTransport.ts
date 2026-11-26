import type { Transport } from '@codemirror/lsp-client'

type Handler = (message: string) => void

const handlers = new Map<string, Set<Handler>>()
let subscribed = false

/** One language server session over IPC. Every session shares one IPC listener that dispatches by session id. */
export function ipcTransport(session: string): Transport {
  if (!subscribed) {
    subscribed = true
    window.manta.onLspMessage((from, message) => {
      for (const handler of handlers.get(from) ?? []) handler(message)
    })
  }
  return {
    send: (message) => window.manta.lspSend(session, message),
    subscribe: (handler) => {
      const forSession = handlers.get(session) ?? new Set<Handler>()
      forSession.add(handler)
      handlers.set(session, forSession)
    },
    unsubscribe: (handler) => {
      const forSession = handlers.get(session)
      forSession?.delete(handler)
      if (forSession?.size === 0) handlers.delete(session)
    }
  }
}
