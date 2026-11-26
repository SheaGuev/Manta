import { describe, expect, it } from 'vitest'
import { frame, MessageReader } from '../framing'

describe('frame', () => {
  it('counts bytes, not characters, for non-ASCII text', () => {
    const framed = frame('{"t":"é"}').toString('utf8')
    expect(framed).toBe('Content-Length: 10\r\n\r\n{"t":"é"}')
  })
})

describe('MessageReader', () => {
  it('reads one message', () => {
    expect(new MessageReader().push(frame('{"a":1}'))).toEqual(['{"a":1}'])
  })

  it('reads several messages from one chunk', () => {
    const chunk = Buffer.concat([frame('{"a":1}'), frame('{"b":2}')])
    expect(new MessageReader().push(chunk)).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('waits for the rest of a message split across chunks, even inside a multi-byte character', () => {
    const whole = frame('{"t":"héllo"}')
    const reader = new MessageReader()
    const splitAt = whole.indexOf(Buffer.from('é')) + 1
    expect(reader.push(whole.subarray(0, 5))).toEqual([])
    expect(reader.push(whole.subarray(5, splitAt))).toEqual([])
    expect(reader.push(whole.subarray(splitAt))).toEqual(['{"t":"héllo"}'])
  })

  it('accepts other headers and any header case', () => {
    const chunk = Buffer.from('content-type: application/vscode-jsonrpc\r\ncontent-length: 2\r\n\r\n{}')
    expect(new MessageReader().push(chunk)).toEqual(['{}'])
  })

  it('skips a header block without a length and reads the next message', () => {
    const chunk = Buffer.concat([Buffer.from('X-Junk: 1\r\n\r\n'), frame('{"ok":true}')])
    expect(new MessageReader().push(chunk)).toEqual(['{"ok":true}'])
  })

  it('returns nothing for an empty chunk', () => {
    expect(new MessageReader().push(Buffer.alloc(0))).toEqual([])
  })
})
