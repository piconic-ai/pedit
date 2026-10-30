/** The host of the public relay, whose operator the terms and privacy pages name. */
export const PUBLIC_RELAY_HOST = 'edit.piconic.ai'

export const SOURCE_URL = 'https://github.com/piconic-ai/pedit'

/** How wide the info panel opens, at most. */
export const INFO_WIDTH = 220

/** The stem and dot of the circled "i", on a 24 by 24 grid; the circle is drawn on its own. */
export const INFO_STEM = 'M12 11v5M12 8h.01'

export interface InfoLink {
  label: string
  href: string
}

/**
 * The links the info panel shows. The terms and privacy pages speak for the
 * public relay's operator, so a relay someone else runs, which serves the same
 * pages, links to the source only.
 */
export function infoLinks(hostname: string): InfoLink[] {
  const legal: InfoLink[] =
    hostname === PUBLIC_RELAY_HOST
      ? [
          { label: 'Terms of Use', href: '/terms' },
          { label: 'Privacy Policy', href: '/privacy' },
        ]
      : []
  return [...legal, { label: 'GitHub', href: SOURCE_URL }]
}
