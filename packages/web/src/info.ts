/** The host of the public relay, whose operator the terms and privacy pages name. */
export const PUBLIC_RELAY_HOST = 'edit.piconic.ai'

export const SOURCE_URL = 'https://github.com/piconic-ai/pedit'

/** How wide the info panel opens, at most. */
export const INFO_WIDTH = 220

/** The stem and dot of the circled "i", on a 24 by 24 grid; the circle is drawn on its own. */
export const INFO_STEM = 'M12 11v5M12 8h.01'

/** A page with its corner folded and two lines of text: the terms. */
const DOCUMENT = 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6'
/** A shield: the privacy policy. */
const SHIELD = 'M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z'
/** Angle brackets: the source. */
const CODE = 'M8 7l-5 5 5 5M16 7l5 5-5 5'

export interface InfoLink {
  label: string
  href: string
  /** Its icon, a path on a 24 by 24 grid. */
  icon: string
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
          { label: 'Terms of Use', href: '/terms', icon: DOCUMENT },
          { label: 'Privacy Policy', href: '/privacy', icon: SHIELD },
        ]
      : []
  return [...legal, { label: 'GitHub', href: SOURCE_URL, icon: CODE }]
}
