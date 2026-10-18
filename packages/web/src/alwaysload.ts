import type { FrameProvider } from '@pedit/protocol/csp'
import { defaultStore, type Store as Storage } from './storage.ts'
import { Store } from './store.ts'

export const ALWAYS_LOAD_KEY = 'pedit:always-load'

/**
 * Who serves a preview frame, as this browser remembers it: a built-in
 * provider such as 'youtube' or 'figma', or 'custom:' and the origin of a
 * FRAME_SOURCES site. Never a URL:
 * the list holds nothing about a room or what someone wrote in it.
 */
export type ProviderId = string

const KNOWN: Record<FrameProvider, string> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  loom: 'Loom',
  figma: 'Figma',
  codepen: 'CodePen',
  stackblitz: 'StackBlitz',
  observable: 'Observable',
  spotify: 'Spotify',
  soundcloud: 'SoundCloud',
  miro: 'Miro',
}
const CUSTOM = 'custom:'

/** The origin of a custom provider id, or null if it is not a well-formed one. */
function customOrigin(id: string): URL | null {
  if (!id.startsWith(CUSTOM)) return null
  const origin = id.slice(CUSTOM.length)
  try {
    const url = new URL(origin)
    const web = url.protocol === 'https:' || url.protocol === 'http:'
    return web && url.origin === origin ? url : null
  } catch {
    return null
  }
}

export function isProviderId(id: unknown): id is ProviderId {
  return typeof id === 'string' && (Object.hasOwn(KNOWN, id) || customOrigin(id) !== null)
}

/** The id of a custom provider for a frame src, from its origin alone. */
export function customProvider(src: URL): ProviderId {
  return `${CUSTOM}${src.origin}`
}

/** How the preview and the settings name a provider: its name, or a custom site's host. */
export function providerLabel(id: ProviderId): string {
  if (Object.hasOwn(KNOWN, id)) return KNOWN[id as FrameProvider]
  const url = customOrigin(id)
  if (!url) return id
  // Spell out plain HTTP, so it cannot pass for the HTTPS site of the same host.
  return url.protocol === 'https:' ? url.host : url.origin
}

/** The providers this browser always loads; anything malformed is left out. */
export function parseAlwaysLoad(value: unknown): ProviderId[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter(isProviderId))]
}

export function loadAlwaysLoad(store: Storage | null = defaultStore()): ProviderId[] {
  try {
    const raw = store?.getItem(ALWAYS_LOAD_KEY)
    return parseAlwaysLoad(raw ? JSON.parse(raw) : null)
  } catch {
    return []
  }
}

export function saveAlwaysLoad(
  ids: readonly ProviderId[],
  store: Storage | null = defaultStore(),
): void {
  try {
    store?.setItem(ALWAYS_LOAD_KEY, JSON.stringify(parseAlwaysLoad(ids)))
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
}

/**
 * The providers whose preview frames load without a click, in this browser
 * only: nothing about it goes over the wire. `ids` is published only when the
 * list changes. Remembering a provider never widens what pedit frames: a
 * placeholder still loads only what frameFor allows for its src.
 *
 * Other pedit tabs share the stored list, so each change starts from what is
 * stored now rather than from this tab's copy: a stale tab must not bring
 * back a provider someone forgot elsewhere. `refresh` takes in such changes.
 */
export class AlwaysLoad {
  readonly ids: Store<readonly ProviderId[]>
  #store: Storage | null

  constructor(store: Storage | null = defaultStore()) {
    this.#store = store
    this.ids = new Store<readonly ProviderId[]>(loadAlwaysLoad(store))
  }

  has(id: ProviderId | null): boolean {
    return id !== null && this.ids.get().includes(id)
  }

  remember(id: ProviderId): void {
    if (!isProviderId(id)) return
    const ids = this.#current()
    if (ids.includes(id)) return this.#publish(ids)
    this.#publish([...ids, id])
    saveAlwaysLoad(this.ids.get(), this.#store)
  }

  forget(id: ProviderId): void {
    const ids = this.#current()
    if (!ids.includes(id)) return this.#publish(ids)
    this.#publish(ids.filter((i) => i !== id))
    saveAlwaysLoad(this.ids.get(), this.#store)
  }

  /** Takes in what another tab stored, e.g. on a `storage` event for ALWAYS_LOAD_KEY. */
  refresh(): void {
    this.#publish(this.#current())
  }

  /** What is stored now, or this page's copy when storage cannot be read. */
  #current(): readonly ProviderId[] {
    if (!this.#store) return this.ids.get()
    try {
      const raw = this.#store.getItem(ALWAYS_LOAD_KEY)
      return parseAlwaysLoad(raw ? JSON.parse(raw) : null)
    } catch {
      return this.ids.get()
    }
  }

  #publish(ids: readonly ProviderId[]): void {
    const now = this.ids.get()
    if (ids.length === now.length && ids.every((id, i) => id === now[i])) return
    this.ids.set(ids)
  }
}
