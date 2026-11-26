import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/**
 * Token colours for code files. Each reads a `--code-<kind>` variable that an editor theme from the
 * Plugins view sets (`lib/editorTheme.ts`); the fallbacks are tuned to the app's dark palette.
 */
export const codeHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--code-keyword, #c792ea)', fontStyle: 'var(--code-keyword-style, normal)' },
    { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--code-string, #a5d6a7)' },
    { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--code-number, #f7b267)' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--code-comment, #6c6d73)', fontStyle: 'var(--code-comment-style, italic)' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--code-function, #82aaff)' },
    { tag: [t.typeName, t.className, t.namespace], color: 'var(--code-type, #ffcb6b)' },
    { tag: [t.propertyName, t.attributeName], color: 'var(--code-property, #89ddff)' },
    { tag: [t.tagName], color: 'var(--code-tag, #f07178)' },
    { tag: [t.definition(t.variableName)], color: 'var(--code-variable, #e4e4e7)' },
    { tag: [t.heading], color: 'var(--code-fg, #e4e4e7)', fontWeight: '700' },
    { tag: [t.link, t.url], color: 'var(--code-link, #7aa7ff)' },
    { tag: [t.invalid], color: 'var(--code-invalid, #ec6a64)' }
  ])
)
