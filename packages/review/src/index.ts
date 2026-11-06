import { PeditReview } from './element.ts'

// Two copies of the bundle on a page must not both define the element.
if (!customElements.get('pedit-review')) customElements.define('pedit-review', PeditReview)

export type { ReviewErrorReason } from './element.ts'
