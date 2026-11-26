/** A file under `rootUri` as a `file://` URI, each path segment percent-encoded. */
export function fileUri(rootUri: string, relPath: string): string {
  return `${rootUri.replace(/\/$/, '')}/${relPath.split('/').map(encodeURIComponent).join('/')}`
}

/** The absolute path of a `file://` URI; servers and Node encode characters like `@` and spaces differently, so compare paths, not URIs. */
export function uriPath(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).pathname)
  } catch {
    return uri
  }
}

/** `uri` relative to `rootUri`, or null when it's outside the root. */
export function relativeTo(rootUri: string, uri: string): string | null {
  const root = uriPath(rootUri).replace(/\/$/, '')
  const file = uriPath(uri)
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : null
}
