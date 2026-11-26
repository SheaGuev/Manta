import { inflateRawSync } from 'node:zlib'

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_FILE_HEADER = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50
const STORED = 0
const DEFLATED = 8
/** The end record is 22 bytes plus a comment of up to 64 KB, so it sits in the file's last 65,557 bytes. */
const END_SEARCH = 22 + 0xffff

/**
 * The files in a zip archive, by name: enough for Mason's `registry.json.zip` and a VS Code theme's
 * `.vsix`. Stored and deflated entries only; folders are skipped. Archives with executables are
 * unpacked with the system's `unzip` instead, which keeps file modes.
 */
export function readZip(archive: Buffer): Map<string, Buffer> {
  let end = -1
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - END_SEARCH); i--) {
    if (archive.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('Not a zip archive')
  const count = archive.readUInt16LE(end + 10)
  let at = archive.readUInt32LE(end + 16)
  const files = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== CENTRAL_FILE_HEADER) throw new Error('Corrupt zip directory')
    const method = archive.readUInt16LE(at + 10)
    const compressedSize = archive.readUInt32LE(at + 20)
    const nameLength = archive.readUInt16LE(at + 28)
    const extraLength = archive.readUInt16LE(at + 30)
    const commentLength = archive.readUInt16LE(at + 32)
    const localHeader = archive.readUInt32LE(at + 42)
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    at += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    if (archive.readUInt32LE(localHeader) !== LOCAL_FILE_HEADER) throw new Error(`Corrupt zip entry ${name}`)
    const dataStart = localHeader + 30 + archive.readUInt16LE(localHeader + 26) + archive.readUInt16LE(localHeader + 28)
    const data = archive.subarray(dataStart, dataStart + compressedSize)
    if (method === STORED) files.set(name, Buffer.from(data))
    else if (method === DEFLATED) files.set(name, inflateRawSync(data))
    else throw new Error(`Unsupported zip compression ${method} in ${name}`)
  }
  return files
}
