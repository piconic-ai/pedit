import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { fixLink } from './links.ts'

/**
 * The Markdown of a canvas text card, as Obsidian shows it: links, emphasis,
 * code, lists, headings and quotes. A card is small and anyone in the room can
 * write one, so it loads nothing: an image shows as its alt text, and raw HTML
 * as text. The board loads this module once a canvas opens (board.ts), apart
 * from the preview's, which brings embeds and frontmatter along.
 */
// A line break in the text is one on the card, as Obsidian draws it.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
md.renderer.rules.image = (tokens, idx) => md.utils.escapeHtml(tokens[idx]?.content ?? '')

const purify = DOMPurify(window)

purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName !== 'A') return
  const el = node as Element
  fixLink(el)
  // Clicked to follow, not to drag the card.
  el.setAttribute('class', 'nodrag')
})

/** What a card's Markdown may become; nothing that loads or runs. */
const ALLOWED_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]

/** A text card's Markdown as sanitised nodes. */
export function renderCard(text: string): DocumentFragment {
  return purify.sanitize(md.render(text).trim(), {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'start'],
    RETURN_DOM_FRAGMENT: true,
  })
}
