/** Kept in step with main's `EXTERNAL_PROTOCOLS`: anything else main refuses to open. */
const OPENABLE: readonly string[] = ['http:', 'https:', 'mailto:']

export interface ExternalLink {
  url: string
  /** The host, or the address for `mailto:`; the URL itself when it doesn't parse. */
  where: string
  /** Main opens it in the user's browser or mail app. */
  openable: boolean
}

export function externalLink(url: string): ExternalLink {
  if (!URL.canParse(url)) return { url, where: url, openable: false }
  const parsed = new URL(url)
  const where = parsed.protocol === 'mailto:' ? parsed.pathname : parsed.host || url
  return { url, where, openable: OPENABLE.includes(parsed.protocol) }
}
