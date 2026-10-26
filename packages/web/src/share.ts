import type { Access } from '@pedit/protocol'

/** A link to the room someone in it can hand out (#122). */
export interface ShareLink {
  access: Access
  /** What the Share menu calls it. */
  label: string
  url: string
  /** Why it cannot be handed out, if it cannot. */
  unavailable?: string
}

const LABELS: Record<Access, string> = {
  edit: 'Copy edit link',
  comment: 'Copy comment-only link',
  read: 'Copy read-only link',
}

/** What a copied link is called in the notice that says it was copied. */
export const COPIED: Record<Access, string> = {
  edit: 'Edit link copied.',
  comment: 'Comment-only link copied.',
  read: 'Read-only link copied.',
}

/**
 * The links this browser can hand out: its own and the ones below it, from
 * the fragments its link derives (RoomKeys.fragments), never from the
 * address bar, which holds this browser's own secret. A comment-only link is
 * of no use while the host shares no comments.
 */
export function shareLinks(
  origin: string,
  roomId: string,
  fragments: Partial<Record<Access, string>>,
  commentable: boolean,
): ShareLink[] {
  const links: ShareLink[] = []
  for (const access of ['edit', 'comment', 'read'] as const) {
    const fragment = fragments[access]
    if (!fragment) continue
    const link: ShareLink = {
      access,
      label: LABELS[access],
      url: `${origin}/r/${roomId}#${fragment}`,
    }
    if (access === 'comment' && !commentable) link.unavailable = 'The host shares no comments.'
    links.push(link)
  }
  return links
}
