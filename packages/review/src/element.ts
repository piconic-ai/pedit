import type { SocketLike } from '@pedit/protocol'
import { mountBanner, mountNotice } from '../../web/src/core/banner.ts'
import { mountComments } from '../../web/src/core/comments-mount.ts'
import '../../web/src/core/components/Participants.tsx'
import coreCss from '../../web/src/core/core.css?inline'
import { mountTextEditor } from '../../web/src/core/editor.ts'
import { FileSet } from '../../web/src/core/files.ts'
import { guardDrops } from '../../web/src/core/guard.ts'
import { type Link, parseLink } from '../../web/src/core/link.ts'
import {
  openRoom,
  type ReviewStatus,
  type Room,
  RoomOpenError,
} from '../../web/src/core/open-room.ts'
import { mountComponent } from '../../web/src/core/render.ts'
import { type Readable, Store } from '../../web/src/core/store.ts'
import hostCss from './host.css?inline'
import { type Labels, resolveLabels } from './labels.ts'
import { parseRelayUrl } from './relay.ts'

const NARROW_QUERY = '(max-width: 720px)'
const MAX_NAME = 64

export type ReviewErrorReason = 'bad-link' | 'unsupported-browser' | 'missing-relay' | 'open-failed'

/** Hooks for tests only: a page never sets them. */
export interface ReviewTesting {
  createSocket?: (url: string, headers?: Record<string, string>, protocols?: string[]) => SocketLike
  fetch?: typeof fetch
  /** Stands in for reloading the page, which jsdom cannot do. */
  reload?: () => void
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  if (className) node.className = className
  return node
}

declare const __PEDIT_REVIEW_VERSION__: string

/**
 * `<pedit-review relay="https://…">`: reviews the room whose link is in the
 * page's `#fragment`, inside a shadow root. The link goes nowhere but the
 * browser: the relay sees ciphertext only. Events (bubbling, composed):
 * `pedit-status` (`detail.status`) and `pedit-error` (`detail.reason`, `detail.message`).
 */
export class PeditReview extends HTMLElement {
  /** The @pedit/review version this bundle was built from (also its first line, as a banner). */
  static get version(): string {
    return __PEDIT_REVIEW_VERSION__
  }

  /** Test-only: the socket and fetch the room uses. Never read from the page. */
  static testing: ReviewTesting = {}

  #shadow: ShadowRoot | undefined
  /** Stops what the current mount made, in reverse order. */
  #disposers: (() => void | Promise<void>)[] = []
  /** Counts mounts: one that finds it was left behind by a newer one stops. */
  #generation = 0
  /** The name typed in the form, kept in this element only so a remount does not ask again. */
  #typed: string | undefined
  #win: Window | null = null
  /** The link being opened or open: a hashchange to the same one does nothing. */
  #current: Link | undefined
  /** From `lang` and `labels`, read each time the element opens a room. */
  #labels: Labels = resolveLabels(null, null)

  connectedCallback(): void {
    this.#win = this.ownerDocument.defaultView
    this.#win?.addEventListener('hashchange', this.#onHash)
    void this.#start()
  }

  disconnectedCallback(): void {
    this.#win?.removeEventListener('hashchange', this.#onHash)
    this.#win = null
    this.#current = undefined
    void this.#stop()
  }

  #onHash = (): void => {
    // An in-page anchor or a cleared hash is not a new room.
    const link = parseLink(this.#win?.location.hash ?? '')
    if (!link) return
    if (link.id === this.#current?.id && link.key === this.#current.key) return
    void this.#start()
  }

  #root(): ShadowRoot {
    if (this.#shadow) return this.#shadow
    const root = this.attachShadow({ mode: 'open' })
    // The styles are adopted once; CodeMirror adds its own sheet after them.
    const Sheet = this.ownerDocument.defaultView?.CSSStyleSheet ?? CSSStyleSheet
    try {
      const sheets = [coreCss, hostCss].map((css) => {
        const sheet = new Sheet()
        sheet.replaceSync(css)
        return sheet
      })
      root.adoptedStyleSheets = sheets
    } catch {
      // No constructable stylesheets: plain style elements do the same.
      for (const css of [coreCss, hostCss]) {
        const style = this.ownerDocument.createElement('style')
        style.textContent = css
        root.append(style)
      }
    }
    this.#shadow = root
    return root
  }

  #stop(): Promise<void> {
    this.#generation++
    const run = this.#disposers.splice(0).reverse()
    // Each one runs whatever the others do: the room is the last.
    return (async () => {
      for (const dispose of run) {
        try {
          await dispose()
        } catch {
          // Nothing to do with a failed teardown; the next one must still run.
        }
      }
    })()
  }

  #emit(name: 'pedit-status' | 'pedit-error', detail: object): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
  }

  #fail(reason: ReviewErrorReason, key: keyof Labels): void {
    const message = this.#labels[key]
    const root = this.#root()
    const box = el(this.ownerDocument, 'div', 'review-message')
    box.setAttribute('role', 'alert')
    box.textContent = message
    root.append(box)
    this.#emit('pedit-error', { reason, message })
  }

  /** Opens the room of `again` (a reconnect) or of the page's hash. */
  async #start(again?: Link): Promise<void> {
    void this.#stop()
    this.#current = undefined
    const generation = this.#generation
    this.#labels = resolveLabels(
      this.getAttribute('lang') ?? this.closest('[lang]')?.getAttribute('lang') ?? null,
      this.getAttribute('labels'),
    )
    const root = this.#root()
    const header = this.#clear(root)

    const relay = parseRelayUrl(this.getAttribute('relay'))
    if (!relay) {
      this.#fail('missing-relay', 'missingRelay')
      return
    }
    // A reconnect keeps the room open before: the hash may be an in-page anchor by now.
    const link = again ?? parseLink(this.#win?.location.hash ?? '')
    if (!link) {
      this.#fail('bad-link', 'badLink')
      return
    }
    this.#current = link
    const attr = this.getAttribute('name')?.trim()
    const name = (attr || this.#typed || '').slice(0, MAX_NAME)
    if (!name) {
      this.#askName(generation, (typed) => {
        this.#typed = typed
        void this.#start(link)
      })
      return
    }

    const room = await this.#open(relay, link, name, generation)
    if (room) this.#mount(root, header, room, name, link)
  }

  /** Empties the shadow root but its styles, and puts back the header with its slots. */
  #clear(root: ShadowRoot): HTMLElement {
    for (const child of [...root.children]) if (child.localName !== 'style') child.remove()
    // The branding shows in every state, before joining too.
    const header = el(this.ownerDocument, 'header', 'review-header')
    for (const name of ['logo', 'title']) {
      const slot = el(this.ownerDocument, 'slot')
      slot.name = name
      header.append(slot)
    }
    root.append(header)
    return header
  }

  /** The opened room, or null when it failed (said on the page) or a newer mount took over. */
  async #open(relay: URL, link: Link, name: string, generation: number): Promise<Room | null> {
    let room: Room
    try {
      room = await openRoom({
        relay,
        roomId: link.id,
        fragment: link.key,
        me: { name },
        createSocket: PeditReview.testing.createSocket,
        fetch: PeditReview.testing.fetch,
      })
    } catch (e) {
      // A mount left behind by a newer one says nothing, whatever went wrong.
      if (generation !== this.#generation) return null
      this.#current = undefined
      // Fixed words: an error's own text is never shown or sent on.
      if (e instanceof RoomOpenError)
        this.#fail(e.reason, e.reason === 'bad-link' ? 'badLink' : 'unsupportedBrowser')
      else this.#fail('open-failed', 'openFailed')
      return null
    }
    if (generation !== this.#generation) {
      await room.dispose()
      return null
    }
    return room
  }

  #askName(generation: number, done: (name: string) => void): void {
    const doc = this.ownerDocument
    const form = el(doc, 'form', 'review-join')
    const label = el(doc, 'label')
    label.textContent = `${this.#labels.yourName} `
    const input = el(doc, 'input')
    input.name = 'name'
    input.required = true
    input.maxLength = MAX_NAME
    input.autocomplete = 'off'
    label.append(input)
    const button = el(doc, 'button')
    button.type = 'submit'
    button.textContent = this.#labels.join
    form.append(label, button)
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const typed = input.value.trim()
      if (typed && generation === this.#generation) done(typed)
    })
    this.#root().append(form)
  }

  #mount(root: ShadowRoot, header: HTMLElement, room: Room, name: string, link: Link): void {
    const doc = this.ownerDocument
    const disposers = this.#disposers
    disposers.push(() => room.dispose())

    const layout = el(doc, 'div', 'review')
    const file = el(doc, 'span', 'file')
    const people = el(doc, 'div', 'people-host')
    const access = el(doc, 'span', 'access')
    const toggle = el(doc, 'button', 'comments-button')
    toggle.type = 'button'
    toggle.textContent = this.#labels.comments
    toggle.hidden = true
    header.append(file, people, access, toggle)
    const banner = el(doc, 'div', 'banner-slot')
    const notice = el(doc, 'div', 'notice-slot')
    const main = el(doc, 'main', 'editor')
    const source = el(doc, 'div', 'source')
    const commentsHost = el(doc, 'div', 'comments-host')
    main.append(source, commentsHost)
    const status = el(doc, 'div', 'visually-hidden')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    layout.append(header, status, banner, notice, main)
    root.append(layout)
    disposers.push(() => layout.remove())

    const narrow = this.#narrow(disposers)
    const words = this.#labels
    const label = {
      comment: { text: words.commentOnly, title: words.commentOnlyTitle },
      read: { text: words.readOnly, title: words.readOnlyTitle },
    }[room.access as string]
    access.hidden = !label
    if (label) {
      access.textContent = label.text
      access.title = label.title
    }

    const named = (value: string | null) => {
      if (value) file.textContent = value
    }
    const files = new FileSet(room, {
      name,
      onManifest: (known) => named(known.find((f) => f.id === files.shown.get().id)?.path ?? null),
    })
    disposers.push(() => files.dispose())
    // Until the host lists the room's files, its state names the file.
    room.hooks.people = (host) => {
      if (typeof host?.file === 'string' && room.files.get().length === 0) named(host.file)
    }
    const editor = mountTextEditor({ room, files, parent: source, root })
    disposers.push(() => editor.dispose())
    const comments = mountComments({
      room,
      files,
      editor: editor.view,
      parent: commentsHost,
      keyTarget: root,
      floating: {
        host: root,
        viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
        onFrame: (fn) => void requestAnimationFrame(fn),
        onChange(fn) {
          // The page around scrolls the button's place; so can the shadow root's own parts.
          window.addEventListener('scroll', fn, true)
          window.addEventListener('resize', fn)
          root.addEventListener('scroll', fn, true)
          return () => {
            window.removeEventListener('scroll', fn, true)
            window.removeEventListener('resize', fn)
            root.removeEventListener('scroll', fn, true)
          }
        },
      },
      narrow,
      prefs: null,
    })
    disposers.push(() => comments.dispose())
    disposers.push(
      mountBanner(banner, room, {
        // Leave the room and open it again from the same link. An outdated page
        // needs the newer bundle the integrator serves, which only a reload loads.
        onReconnect: () => {
          if (room.status.get() === 'client-outdated')
            (PeditReview.testing.reload ?? (() => this.#win?.location.reload()))()
          else void this.#start(link)
        },
      }),
    )
    disposers.push(mountNotice(notice, room))
    disposers.push(guardDrops(root))
    disposers.push(mountComponent(people, 'Participants', { people: room.people, narrow }))

    const pressed = (open: boolean) => toggle.setAttribute('aria-pressed', open ? 'true' : 'false')
    pressed(comments.open.get())
    disposers.push(comments.open.subscribe(pressed))
    toggle.hidden = !files.commentable.get()
    disposers.push(files.commentable.subscribe((c) => (toggle.hidden = !c)))
    const onToggle = () => comments.toggle()
    toggle.addEventListener('click', onToggle)
    disposers.push(() => toggle.removeEventListener('click', onToggle))

    // The first status is `connecting`; the store only speaks when it changes.
    const say = (value: ReviewStatus) => {
      status.textContent = {
        connecting: words.connecting,
        live: words.live,
        'host-away': words.hostAway,
        ended: words.ended,
      }[value]
      this.#emit('pedit-status', { status: value })
    }
    say(room.review.get())
    disposers.push(room.review.subscribe(say))
    room.connect()
  }

  /** Whether the screen is narrow, read through the element's own window. */
  #narrow(disposers: (() => void)[]): Readable<boolean> {
    const query = this.#win?.matchMedia?.(NARROW_QUERY)
    const store = new Store(query?.matches ?? false)
    if (query) {
      const onChange = () => store.set(query.matches)
      query.addEventListener('change', onChange)
      disposers.push(() => query.removeEventListener('change', onChange))
    }
    return store
  }
}
