/** Electron wraps errors thrown in main as `Error invoking remote method '<channel>': Error: <message>`. */
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:\w*Error: )?/

export function withoutIpcPrefix(message: string): string {
  return message.replace(IPC_ERROR_PREFIX, '')
}
