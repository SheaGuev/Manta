import { Copy, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { externalLink } from '../lib/externalLink'

interface OpenLinkDialogProps {
  url: string
  onClose: () => void
}

/**
 * Asks before opening a terminal hyperlink (OSC 8), whose visible text can differ from where it goes.
 * Enter opens it in the browser, Escape or a click outside cancels.
 */
export function OpenLinkDialog({ url, onClose }: OpenLinkDialogProps): React.JSX.Element {
  const link = externalLink(url)
  const [copied, setCopied] = useState(false)
  const open = (): void => {
    /** Main's window-open handler hands it to the browser; the app window never navigates. */
    if (link.openable) window.open(link.url)
    onClose()
  }
  const copy = (): void =>
    void navigator.clipboard
      .writeText(link.url)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog open-link-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          open()
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2>Open link on {link.where}?</h2>
        <code className="open-link-url">{link.url}</code>
        {!link.openable && <p className="dialog-error">Manta only opens http, https and mailto links.</p>}
        <div className="dialog-actions">
          <button type="button" className="primary-button open-link-copy" onClick={copy}>
            <Copy size={13} /> {copied ? 'Copied' : 'Copy link'}
          </button>
          <button type="button" className="primary-button" onClick={onClose} autoFocus={!link.openable}>
            Cancel
          </button>
          {link.openable && (
            <button type="submit" className="primary-button accent" autoFocus>
              <ExternalLink size={13} /> Open
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
