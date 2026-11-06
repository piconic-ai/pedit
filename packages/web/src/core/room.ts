import type { Access } from '@pedit/protocol'
import { safeAvatar } from './avatar.ts'
import { socketUrl } from './relay.ts'

/** The room's WebSocket URL on `relay`, without the key (see relay.ts). */
export function roomSocketUrl(relay: URL, id: string): string {
  return socketUrl(relay, id)
}

export interface Participant {
  clientId: number
  name: string
  color: string
  /** Only from hosts we allow; see safeAvatar. */
  avatar?: string
  isHost: boolean
  isSelf: boolean
  /** What the link they joined with lets them do, when known. */
  access?: Access
  /**
   * The account they signed in with, when it differs from the name they go
   * by (#213). Like the name, the peer says it itself: it tells honest
   * actors on one account apart, and proves nothing.
   */
  account?: string
}

type State = { [key: string]: unknown }

/**
 * A colour a peer chose, if it is a plain hex colour like colorFor() makes.
 * Peers set their own awareness, and the colour ends up in style attributes,
 * so anything else (another declaration, a url()) must not get through.
 */
export function safeColor(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? value : null
}

/**
 * Replaces a peer's colours that are not plain hex colours, in place, before
 * anything draws them. y-codemirror.next reads user.color and user.colorLight
 * straight from awareness for remote cursors, so they are cleaned where they
 * arrive. Returns whether anything changed.
 */
export function sanitizeUser(state: State, clientId: number): boolean {
  const user = state.user
  if (!user || typeof user !== 'object') return false
  const u = user as { color?: unknown; colorLight?: unknown }
  const color = safeColor(u.color)
  const light = safeColor(u.colorLight)
  if ((u.color === undefined || color) && (u.colorLight === undefined || light)) return false
  const fallback = color ?? colorFor(clientId)
  state.user = { ...u, color: fallback, colorLight: light ?? selectionTint(fallback) }
  return true
}

/**
 * The people in the room. With `accessOf` (RoomClient.accessOf), each says
 * what the link they joined with lets them do, and only an editor's state
 * can make its peer the host: anyone can say they are the host.
 */
export function participants(
  states: Map<number, State>,
  selfId: number,
  accessOf?: (clientId: number) => Access | undefined,
): Participant[] {
  const list: Participant[] = []
  for (const [clientId, state] of states) {
    const user = (state.user ?? {}) as {
      name?: unknown
      color?: unknown
      avatar?: unknown
      account?: unknown
    }
    const name = typeof user.name === 'string' ? user.name : state.name
    const shown = typeof name === 'string' && name ? name : 'anonymous'
    const account = typeof user.account === 'string' ? user.account.trim().slice(0, 40) : ''
    const access = accessOf?.(clientId)
    const isHost = state.role === 'host' && (!accessOf || access === 'edit')
    const avatar = safeAvatar(user.avatar)
    list.push({
      clientId,
      name: shown,
      color: safeColor(user.color) ?? (isHost ? '#1f7a64' : '#7a828d'),
      ...(avatar && { avatar }),
      isHost,
      isSelf: clientId === selfId,
      ...(access && { access }),
      ...(account && account !== shown && { account }),
    })
  }
  return list.sort(
    (a, b) => Number(b.isHost) - Number(a.isHost) || Number(b.isSelf) - Number(a.isSelf),
  )
}

/**
 * Caret labels print white text on these, so each must reach 4.5:1 against
 * white. test/themes.test.ts also checks them against every editor theme.
 */
export const COLORS = [
  // piconic green (#00b769), darkened to carry white text.
  '#00804a',
  '#b85a0e',
  '#4254b5',
  '#b5427a',
  '#5a7a1d',
  '#8a4fbf',
  '#c83d2e',
  '#18708f',
]

export function colorFor(seed: number): string {
  return COLORS[Math.abs(seed) % COLORS.length] ?? '#4254b5'
}

/** The same colour for a name every time, from the colours people get in the room. */
export function colorOf(name: string): string {
  // FNV-1a: short names that differ by a letter still spread over the colours.
  let h = 0x811c9dc5
  for (const c of name) h = Math.imul(h ^ (c.codePointAt(0) ?? 0), 0x01000193)
  return colorFor(h >>> 0)
}

/**
 * Each name in the room with its colour in the header. A name two people
 * share with different colours is left out: it says nothing of who wrote.
 */
export function colorsByName(
  people: readonly { name: string; color: string }[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  const shared = new Set<string>()
  for (const p of people) {
    const had = out.get(p.name)
    if (had !== undefined && had !== p.color) shared.add(p.name)
    out.set(p.name, p.color)
  }
  for (const name of shared) out.delete(name)
  return out
}

/**
 * The alpha others see behind text this browser selects. Readers pick their
 * own theme, so it has to work on all of them; the theme test pins the range.
 */
export const SELECTION_ALPHA = '36'

export function selectionTint(color: string): string {
  return `${color}${SELECTION_ALPHA}`
}
