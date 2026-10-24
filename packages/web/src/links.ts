import { httpUrl } from './embed.ts'

/**
 * A link in rendered Markdown, made safe to follow: a web or mail link opens
 * in a new tab, and any other keeps its text without an href. Leaving this
 * page would lose the key in the URL fragment, and relative and #fragment
 * links cannot resolve here.
 */
export function fixLink(el: Element): void {
  const href = el.getAttribute('href') ?? ''
  if (httpUrl(href) || href.startsWith('mailto:')) {
    el.setAttribute('target', '_blank')
    el.setAttribute('rel', 'noopener noreferrer')
  } else {
    el.removeAttribute('href')
    el.removeAttribute('target')
  }
}
