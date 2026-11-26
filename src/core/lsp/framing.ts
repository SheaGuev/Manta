const HEADER_END = Buffer.from('\r\n\r\n')
const CONTENT_LENGTH = /^content-length:\s*(\d+)\s*$/im

/** Splits a language server's stdout into JSON messages by their `Content-Length` headers. */
export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0)

  /** Returns the messages completed by this chunk, in order; a partial one waits for the next chunk. */
  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const messages: string[] = []
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END)
      if (headerEnd < 0) break
      const length = CONTENT_LENGTH.exec(this.buffer.subarray(0, headerEnd).toString('ascii'))?.[1]
      const bodyStart = headerEnd + HEADER_END.length
      if (length === undefined) {
        /** A header block without a length can't be framed; drop it rather than stall every later message. */
        this.buffer = this.buffer.subarray(bodyStart)
        continue
      }
      const bodyEnd = bodyStart + Number(length)
      if (this.buffer.length < bodyEnd) break
      messages.push(this.buffer.subarray(bodyStart, bodyEnd).toString('utf8'))
      this.buffer = this.buffer.subarray(bodyEnd)
    }
    return messages
  }
}

/** One message with its header, ready for a server's stdin. The length counts bytes, not characters. */
export function frame(json: string): Buffer {
  const body = Buffer.from(json, 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}
