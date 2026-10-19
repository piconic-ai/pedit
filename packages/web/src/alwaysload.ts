import { PROVIDERS, type ProviderId } from '@pedit/protocol/csp'
import { defaultStore, type Store as Storage } from './storage.ts'
import { Store } from './store.ts'

export const ALWAYS_LOAD_KEY = 'pedit:always-load'

export type { ProviderId }

/**
 * Whether `id` names a provider this relay was built with: a key of the
 * registry (packages/protocol/src/embeds/index.ts). That is all the list holds,
 * never a URL: nothing about a room or what someone wrote in it.
 */
export function isProviderId(id: unknown): id is ProviderId {
  return typeof id === 'string' && Object.hasOwn(PROVIDERS, id)
}

/** How the preview and the settings name a provider: its name in the registry. */
export function providerLabel(id: ProviderId): string {
  return PROVIDERS[id].name
}

/**
 * The providers this browser always loads. Anything malformed is left out, and
 * so is an id this relay has no provider for (one dropped from the registry
 * since, or an id from an older pedit).
 */
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

/** Stores `ids`; false when storage is missing or refuses the write. */
export function saveAlwaysLoad(
  ids: readonly ProviderId[],
  store: Storage | null = defaultStore(),
): boolean {
  if (!store) return false
  try {
    store.setItem(ALWAYS_LOAD_KEY, JSON.stringify(parseAlwaysLoad(ids)))
    return true
  } catch {
    // Private mode, storage disabled or full: the choice lasts for this page only.
    return false
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
  /** Set once a write failed: storage then lags this page's choice, so this page's copy wins. */
  #pageOnly = false

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
    this.#save()
  }

  forget(id: ProviderId): void {
    const ids = this.#current()
    if (!ids.includes(id)) return this.#publish(ids)
    this.#publish(ids.filter((i) => i !== id))
    this.#save()
  }

  /** Takes in what another tab stored, e.g. on a `storage` event for ALWAYS_LOAD_KEY. */
  refresh(): void {
    this.#publish(this.#current())
  }

  #save(): void {
    if (!saveAlwaysLoad(this.ids.get(), this.#store)) this.#pageOnly = true
  }

  /**
   * What is stored now, or this page's copy when storage cannot be read or
   * has refused one of this page's writes (reads may still work then).
   */
  #current(): readonly ProviderId[] {
    if (!this.#store || this.#pageOnly) return this.ids.get()
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

/**
 * Follows the changes other pedit tabs store: a `storage` event for
 * ALWAYS_LOAD_KEY, or one with no key (storage cleared), refreshes `always`.
 */
export function followOtherTabs(
  always: AlwaysLoad,
  target: Pick<Window, 'addEventListener'> = window,
): void {
  target.addEventListener('storage', (e) => {
    if (e.key === ALWAYS_LOAD_KEY || e.key === null) always.refresh()
  })
}
