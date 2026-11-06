import { type Readable, Store as Value } from './core/store.ts'
import { defaultStore, type Store } from './storage.ts'

export type ViewMode = 'editor' | 'split' | 'preview' | 'table' | 'canvas'

/**
 * Which views a file has: Markdown has a preview, CSV and TSV a table, and a
 * canvas, which the host shares as nodes and edges rather than text, only
 * its board.
 */
export type ViewKind = 'markdown' | 'table' | 'canvas' | 'plain'

export const VIEW_KEY = 'pedit:view'
export const TABLE_VIEW_KEY = 'pedit:table-view'
export const NARROW_QUERY = '(max-width: 720px)'

interface KindInfo {
  key: string | null
  modes: readonly { mode: ViewMode; label: string }[]
}

const KINDS: Record<ViewKind, KindInfo> = {
  markdown: {
    key: VIEW_KEY,
    modes: [
      { mode: 'editor', label: 'Edit' },
      { mode: 'split', label: 'Split' },
      { mode: 'preview', label: 'Preview' },
    ],
  },
  table: {
    key: TABLE_VIEW_KEY,
    modes: [
      { mode: 'editor', label: 'Text' },
      { mode: 'table', label: 'Table' },
    ],
  },
  canvas: { key: null, modes: [{ mode: 'canvas', label: 'Canvas' }] },
  plain: { key: null, modes: [] },
}

function isModeOf(kind: ViewKind, value: unknown): value is ViewMode {
  return KINDS[kind].modes.some((m) => m.mode === value)
}

/** The mode this browser chose last for this kind of file, or null if it never chose one. */
export function loadViewMode(
  store: Store | null = defaultStore(),
  kind: ViewKind = 'markdown',
): ViewMode | null {
  const key = KINDS[kind].key
  if (!key) return null
  try {
    const value = store?.getItem(key)
    return isModeOf(kind, value) ? value : null
  } catch {
    return null
  }
}

export function saveViewMode(
  mode: ViewMode,
  store: Store | null = defaultStore(),
  kind: ViewKind = 'markdown',
): void {
  const key = KINDS[kind].key
  if (!key || !isModeOf(kind, mode)) return
  try {
    store?.setItem(key, mode)
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
}

/**
 * What to show for the chosen mode. Markdown opens side by side, except on
 * narrow screens where two panes do not fit: there it opens for reading.
 * Tables open as a table.
 */
export function effectiveMode(
  chosen: ViewMode | null,
  narrow: boolean,
  kind: ViewKind = 'markdown',
): ViewMode {
  if (kind === 'plain') return 'editor'
  if (kind === 'canvas') return 'canvas'
  if (kind === 'table') return chosen === 'editor' ? 'editor' : 'table'
  const mode = chosen && isModeOf('markdown', chosen) ? chosen : 'split'
  return narrow && mode === 'split' ? 'preview' : mode
}

export interface ViewSwitchOptions {
  narrow: boolean
  /** Called with the mode to show whenever it may have changed. */
  onApply: (mode: ViewMode) => void
  store?: Store | null
}

/** One view button as the header shows it (components/Header.tsx). */
export interface ViewButton {
  mode: ViewMode
  label: string
  hidden: boolean
  pressed: boolean
  disabled: boolean
  /** Why the button is disabled, as a tooltip. */
  title: string | null
}

const ALL_MODES: readonly ViewMode[] = ['editor', 'split', 'preview', 'table', 'canvas']

/**
 * Which view shows, and the Edit / Split / Preview buttons for Markdown or
 * Text / Table for CSV and TSV. Other files have one view, so the buttons
 * hide and the editor fills the page. The buttons are drawn from `buttons`.
 */
export class ViewSwitch {
  readonly buttons: Readable<readonly ViewButton[]>
  #buttons = new Value<readonly ViewButton[]>([])
  #chosen = new Map<ViewKind, ViewMode | null>()
  #kind: ViewKind = 'markdown'
  #narrow: boolean
  #tableError: string | null = null
  #onApply: (mode: ViewMode) => void
  #store: Store | null

  constructor({ narrow, onApply, store = defaultStore() }: ViewSwitchOptions) {
    this.#store = store
    this.#narrow = narrow
    this.#onApply = onApply
    this.buttons = this.#buttons
    this.#apply()
  }

  get mode(): ViewMode {
    if (this.#kind === 'table' && this.#tableError !== null) return 'editor'
    return effectiveMode(this.#chosenFor(this.#kind), this.#narrow, this.#kind)
  }

  get kind(): ViewKind {
    return this.#kind
  }

  choose(mode: ViewMode): void {
    if (!isModeOf(this.#kind, mode)) return
    this.#chosen.set(this.#kind, mode)
    saveViewMode(mode, this.#store, this.#kind)
    this.#apply()
  }

  setNarrow(narrow: boolean): void {
    this.#narrow = narrow
    this.#apply()
  }

  /** Which views the shared file has. */
  setKind(kind: ViewKind): void {
    this.#kind = kind
    this.#apply()
  }

  /**
   * Why the file cannot show as a table right now, or null when it can.
   * Meanwhile the text editor shows, and the table comes back once it parses.
   */
  setTableError(message: string | null): void {
    if (message === this.#tableError) return
    this.#tableError = message
    this.#apply()
  }

  #chosenFor(kind: ViewKind): ViewMode | null {
    if (!this.#chosen.has(kind)) this.#chosen.set(kind, loadViewMode(this.#store, kind))
    return this.#chosen.get(kind) ?? null
  }

  #apply(): void {
    const mode = this.mode
    const { modes } = KINDS[this.#kind]
    const error = this.#kind === 'table' ? this.#tableError : null
    this.#buttons.set(
      ALL_MODES.map((m) => {
        const info = modes.find((x) => x.mode === m)
        return {
          mode: m,
          label: info?.label ?? '',
          // One view needs no buttons.
          hidden: !info || modes.length < 2 || (m === 'split' && this.#narrow),
          pressed: m === mode,
          disabled: m === 'table' && error !== null,
          title: m === 'table' ? error : null,
        }
      }),
    )
    this.#onApply(mode)
  }
}
