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
/**
 * The GitHub mark, filled: mark-github-24 from Octicons
 * (https://github.com/primer/octicons), MIT License, Copyright (c) 2026
 * GitHub Inc. Listed in THIRD_PARTY_LICENSES (vite.config.ts).
 */
const GITHUB_MARK =
  'M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943'

export interface InfoLink {
  label: string
  href: string
  /** Its icon, a path on a 24 by 24 grid: a line, unless filled. */
  icon: string
  filled?: boolean
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
  return [...legal, { label: 'GitHub', href: SOURCE_URL, icon: GITHUB_MARK, filled: true }]
}
