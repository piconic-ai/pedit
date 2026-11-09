import type { EditorView } from '@codemirror/view'
import type * as Y from 'yjs'
import type { AlwaysLoad } from './alwaysload.ts'
import type { BlockRenderer } from './blockrender.ts'
import type { ImageResolver } from './core/attachments.ts'

/** What acting on an embed placeholder needs. */
export type EmbedRenderer = Pick<
  typeof import('./preview.ts'),
  'loadEmbed' | 'embedProvider' | 'toggleRemember'
>

/** What the canvas cards load: the one-shot render and patch. */
export type Renderer = EmbedRenderer & Pick<typeof import('./preview.ts'), 'render' | 'patch'>

/** What the preview pane loads: the block renderer and the embed functions (blockrender.ts). */
export type PaneRenderer = EmbedRenderer & { BlockRenderer: typeof BlockRenderer }

/** The most snippets "Always load" loads on one page; the rest load on a click. */
export const MAX_REMEMBERED_SNIPPETS = 20

/**
 * Acts on a click, or Enter or Space, on an embed placeholder's controls in
 * rendered Markdown inside `container`: loads its player, or ticks "Always
 * load". The preview and the canvas cards share it.
 */
export function onEmbedControl(
  event: Event,
  container: Element,
  renderer: EmbedRenderer | null,
  alwaysLoad?: AlwaysLoad,
): void {
  const target = event.target instanceof Element ? event.target : null
  const control = target?.closest('.embed-load, .embed-remember')
  const placeholder = control?.closest('[data-embed-src]')
  if (!control || !placeholder || !container.contains(placeholder) || !renderer) return
  // Space would otherwise scroll the preview.
  event.preventDefault()
  if (control.classList.contains('embed-remember')) {
    renderer.toggleRemember(control)
    return
  }
  const remember = placeholder.querySelector('.embed-remember')?.getAttribute('aria-checked')
  const provider = renderer.embedProvider(placeholder)
  if (!renderer.loadEmbed(placeholder)) return
  if (remember === 'true' && provider) alwaysLoad?.remember(provider)
}

/**
 * Loads the players in `container` of the providers this browser always
 * loads, leaving focus where it is. Snippets only up to
 * MAX_REMEMBERED_SNIPPETS: each may hold a large file, and a file of many
 * links would have them all fetched. The rest wait for a click.
 */
export function loadRemembered(
  container: Element,
  renderer: EmbedRenderer,
  always: AlwaysLoad,
): void {
  let snippets = container.querySelectorAll('.embed--snippet.embed--loaded').length
  for (const placeholder of container.querySelectorAll('[data-embed-src]:not(.embed--loaded)')) {
    if (!always.has(renderer.embedProvider(placeholder))) continue
    const snippet = placeholder.classList.contains('embed--snippet')
    if (snippet && snippets >= MAX_REMEMBERED_SNIPPETS) continue
    if (renderer.loadEmbed(placeholder, false) && snippet) snippets++
  }
}

/** A source line and where its block starts in the preview's scroll area. */
export interface Anchor {
  line: number
  top: number
}

/**
 * Where to scroll the preview so it shows the same place as the editor,
 * given anchors sorted by line and by position. Between two anchors the
 * position is interpolated, so long paragraphs scroll smoothly.
 */
export function scrollTarget(anchors: readonly Anchor[], line: number): number {
  let prev: Anchor = { line: 0, top: 0 }
  for (const next of anchors) {
    if (next.line > line) {
      if (next.line === prev.line) return prev.top
      return prev.top + ((next.top - prev.top) * (line - prev.line)) / (next.line - prev.line)
    }
    prev = next
  }
  return prev.top
}

/** Keeps anchors whose line and position both move forward, e.g. a list but not its first item. */
export function monotonic(anchors: readonly Anchor[]): Anchor[] {
  const out: Anchor[] = []
  for (const a of anchors) {
    const last = out.at(-1)
    if (!last || (a.line > last.line && a.top >= last.top)) out.push(a)
  }
  return out
}

/** The editor's first visible line, 0-based, with the fraction of it scrolled past. */
export function topLine(view: EditorView): number {
  const height = Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top)
  const block = view.lineBlockAtHeight(height)
  const line = view.state.doc.lineAt(block.from).number - 1
  const fraction = block.height > 0 ? (height - block.top) / block.height : 0
  return line + Math.min(1, Math.max(0, fraction))
}

/**
 * The rendered Markdown next to the editor. It loads the renderer on first
 * use and redraws at most once a frame, only while it is on screen.
 */
export class PreviewPane {
  readonly element: HTMLElement
  #text: Y.Text
  #load: () => Promise<PaneRenderer>
  #renderer: PaneRenderer | null = null
  // Keeps the article's blocks between renders (blockrender.ts); made once the renderer is loaded.
  #blocks: BlockRenderer | null = null
  #imagesVersion = 0
  // Loads the renderer and the BlockRenderer together, so one is never set without the other.
  #loading: Promise<void> | null = null
  #active = false
  #dirty = true
  #frame = 0
  #onRender: () => void
  #images: ImageResolver | undefined
  #alwaysLoad: AlwaysLoad | undefined

  constructor(
    text: Y.Text,
    options: {
      load?: () => Promise<PaneRenderer>
      onRender?: () => void
      /** Finds the images added during the session. */
      images?: ImageResolver
      /** The article to render into, laid out by components/Layout.tsx. */
      element?: HTMLElement
      /** The providers whose players load without a click, in this browser. */
      alwaysLoad?: AlwaysLoad
    } = {},
  ) {
    this.#text = text
    this.#load = options.load ?? (() => import('./blockrender.ts'))
    this.#onRender = options.onRender ?? (() => {})
    this.#images = options.images
    this.element = options.element ?? document.createElement('article')
    this.#alwaysLoad = options.alwaysLoad
    // Remembering a provider also loads its other players on the page.
    this.#alwaysLoad?.ids.subscribe(() => this.#loadRemembered())
    text.observe(this.#changed)
    // One listener for every embed placeholder the rendered Markdown holds.
    this.element.addEventListener('click', (event) => this.#loadEmbed(event))
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') this.#loadEmbed(event)
    })
  }

  #changed = () => {
    this.#dirty = true
    this.#schedule()
  }

  /** Shows another text, such as another file of the room. */
  setText(text: Y.Text): void {
    if (text === this.#text) return
    this.#text.unobserve(this.#changed)
    this.#text = text
    // Another text shares no blocks with the last one, not even a loaded player.
    this.#blocks?.reset()
    text.observe(this.#changed)
    this.#changed()
  }

  get active(): boolean {
    return this.#active
  }

  set active(on: boolean) {
    this.#active = on
    this.#schedule()
  }

  /** Renders again though the text did not change, e.g. once an image arrives. */
  refresh(): void {
    // Blocks with an image render again: the resolver may answer differently now.
    this.#imagesVersion++
    this.#dirty = true
    this.#schedule()
  }

  /** Scrolls to the place the editor shows. */
  follow(view: EditorView): void {
    const pane = this.element
    const scroller = view.scrollDOM
    // A document that fits the editor leaves the preview for the reader to scroll.
    if (scroller.scrollHeight <= scroller.clientHeight) return
    const max = pane.scrollHeight - pane.clientHeight
    if (
      scroller.scrollTop > 0 &&
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
    ) {
      pane.scrollTop = max
      return
    }
    const origin = pane.getBoundingClientRect().top - pane.scrollTop
    // A root carries its block's first line in the document; the lines nested in it
    // count from there (blockrender.ts).
    const anchors: Anchor[] = []
    for (const root of pane.children) {
      if (!(root instanceof HTMLElement) || root.dataset.line === undefined) continue
      const base = Number(root.dataset.line)
      anchors.push({ line: base, top: root.getBoundingClientRect().top - origin })
      for (const el of root.querySelectorAll<HTMLElement>('[data-line]')) {
        anchors.push({
          line: base + Number(el.dataset.line),
          top: el.getBoundingClientRect().top - origin,
        })
      }
    }
    anchors.push({ line: view.state.doc.lines, top: pane.scrollHeight })
    pane.scrollTop = Math.min(max, scrollTarget(monotonic(anchors), topLine(view)))
  }

  /**
   * Loads the frame whose "Load from" control the event came from, remembering
   * its provider if "Always load" is ticked, or toggles that box.
   */
  #loadEmbed(event: Event): void {
    onEmbedControl(event, this.element, this.#renderer, this.#alwaysLoad)
  }

  /** Loads the players of the providers this browser always loads. */
  #loadRemembered(): void {
    if (this.#alwaysLoad && this.#renderer) {
      loadRemembered(this.element, this.#renderer, this.#alwaysLoad)
    }
  }

  #schedule(): void {
    if (!this.#active || !this.#dirty || this.#frame) return
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0
      void this.#render()
    })
  }

  async #ready(): Promise<void> {
    const renderer = await this.#load()
    this.#renderer = renderer
    this.#blocks ??= new renderer.BlockRenderer(this.element)
  }

  async #render(): Promise<void> {
    if (!this.#renderer || !this.#blocks) {
      try {
        this.#loading ??= this.#ready()
        await this.#loading
      } catch {
        // Offline or a stale deploy: try again on the next change.
        this.#loading = null
        // The article's content is rendered Markdown, kept block by block (blockrender.ts),
        // so this message goes in the same way rather than through a component.
        const message = document.createElement('p')
        message.className = 'preview-error'
        message.textContent = 'The preview could not be loaded.'
        this.element.replaceChildren(message)
        return
      }
    }
    if (!this.#active || !this.#dirty || !this.#blocks) return
    this.#dirty = false
    this.#blocks.update(this.#text.toString(), this.#images, this.#imagesVersion)
    this.#loadRemembered()
    this.#images?.rendered?.()
    this.#onRender()
  }
}
