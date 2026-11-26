// A scripted language server for LanguageServerHost's tests: JSON-RPC over stdio with Content-Length framing.
// After `initialized` it asks the client for configuration, registers for watched files and asks for a
// diagnostics refresh. `test/answers` and `test/watched` report what came back; `test/crash` exits with 3.
let buffer = Buffer.alloc(0)
const answers = []
const watched = []
const notes = []
let initParams = null
const write = (message) => {
  const body = Buffer.from(JSON.stringify(message))
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
}
const handle = (message) => {
  if (message.id !== undefined && !message.method) return answers.push(message)
  switch (message.method) {
    case 'initialize':
      initParams = message.params
      return write({ jsonrpc: '2.0', id: message.id, result: { capabilities: { textDocumentSync: 1 } } })
    case 'initialized':
      write({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message: 'handled initialized' } })
      write({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 1, message: 'something broke' } })
      write({ jsonrpc: '2.0', id: 'srv-config', method: 'workspace/configuration', params: { items: [{ section: 'a' }, { section: 'b' }] } })
      write({ jsonrpc: '2.0', id: 'srv-register', method: 'client/registerCapability', params: { registrations: [{ id: 'w', method: 'workspace/didChangeWatchedFiles' }] } })
      write({ jsonrpc: '2.0', id: 'srv-refresh', method: 'workspace/diagnostic/refresh', params: null })
      write({ jsonrpc: '2.0', id: 'srv-unknown', method: 'custom/thing', params: null })
      return
    case 'test/answers':
      return write({ jsonrpc: '2.0', id: message.id, result: answers })
    case 'test/init':
      return write({ jsonrpc: '2.0', id: message.id, result: initParams })
    case 'test/notes':
      return write({ jsonrpc: '2.0', id: message.id, result: notes })
    case 'workspace/didChangeConfiguration':
      return notes.push(message)
    case 'test/watched':
      return write({ jsonrpc: '2.0', id: message.id, result: watched })
    case 'test/echo':
      return write({ jsonrpc: '2.0', id: message.id, result: message.params })
    case 'workspace/didChangeWatchedFiles':
      return watched.push(...message.params.changes)
    case 'test/crash':
      process.stderr.write('boom: the fake server crashed\n')
      return process.exit(3)
    case 'shutdown':
      return write({ jsonrpc: '2.0', id: message.id, result: null })
    case 'exit':
      return process.exit(0)
  }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1])
    if (buffer.length < end + 4 + length) return
    handle(JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()))
    buffer = buffer.subarray(end + 4 + length)
  }
})
