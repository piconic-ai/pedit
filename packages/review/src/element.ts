import type { SocketLike } from '@pedit/protocol'
import { mountBanner, mountNotice } from '../../web/src/core/banner.ts'
import { mountComments } from '../../web/src/core/comments-mount.ts'
import '../../web/src/core/components/Participants.tsx'
import coreCss from '../../web/src/core/core.css?inline'
import { mountTextEditor } from '../../web/src/core/editor.ts'
import { FileSet } from '../../web/src/core/files.ts'
import { guardDrops } from '../../web/src/core/guard.ts'
import { parseLink } from '../../web/src/core/link.ts'
import { openRoom, type Room, RoomOpenError } from '../../web/src/core/open-room.ts'
import { mountComponent } from '../../web/src/core/render.ts'
import { type Readable, Store } from '../../web/src/core/store.ts'
import hostCss from './host.css?inline'

const NARROW_QUERY = '(max-width: 720px)'
const MAX_NAME = 64

/** What a link below edit lets the reader do, as the header says it. */
const ACCESS_LABELS: Partial<Record<string, { text: string; title: string }>> = {
  comment: { text: 'Comment only', title: 'You can read this file and comment on it.' },
  read: { text: 'Read only', title: 'You can read this file.' },
}

export type ReviewErrorReason = 'bad-link' | 'unsupported-browser' | 'missing-relay'

/** Hooks for tests only: a page never sets them. */
export interface ReviewTesting {
  createSocket?: (url: string, headers?: Record<string, string>, protocols?: string[]) => SocketLike
  fetch?: typeof fetch
}

/** The relay from the attribute: an http(s) URL, or null. */
function parseRelay(value: string | null): URL | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch {
    return null
  }
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

/**
 * `<pedit-review relay="https://…">`: reviews the room whose link is in the
 * page's `#fragment`, inside a shadow root. The link goes nowhere but the
 * browser: the relay sees ciphertext only. Events (bubbling, composed):
 * `pedit-status` (`detail.status`) and `pedit-error` (`detail.reason`, `detail.message`).
 */
export class PeditReview extends HTMLElement {
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

  connectedCallback(): void {
    this.#win = this.ownerDocument.defaultView
    this.#win?.addEventListener('hashchange', this.#onHash)
    void this.#start()
  }

  disconnectedCallback(): void {
    this.#win?.removeEventListener('hashchange', this.#onHash)
    this.#win = null
    void this.#stop()
  }

  #onHash = (): void => {
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
    return (async () => {
      for (const dispose of run) await dispose()
    })()
  }

  #emit(name: 'pedit-status' | 'pedit-error', detail: object): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
  }

  #fail(reason: ReviewErrorReason, message: string): void {
    const root = this.#root()
    const box = el(this.ownerDocument, 'div', 'review-message')
    box.setAttribute('role', 'alert')
    box.textContent = message
    root.append(box)
    this.#emit('pedit-error', { reason, message })
  }

  async #start(): Promise<void> {
    void this.#stop()
    const generation = this.#generation
    const root = this.#root()
    // Keeps the adopted or style sheets; only the content goes.
    for (const child of [...root.children]) if (child.localName !== 'style') child.remove()

    const relay = parseRelay(this.getAttribute('relay'))
    if (!relay) {
      this.#fail('missing-relay', 'This page does not say which relay to use.')
      return
    }
    const link = parseLink(this.#win?.location.hash ?? '')
    if (!link) {
      this.#fail('bad-link', 'This is not a review link.')
      return
    }
    const attr = this.getAttribute('name')?.trim()
    const name = (attr || this.#typed || '').slice(0, MAX_NAME)
    if (!name) {
      this.#askName(generation, (typed) => {
        this.#typed = typed
        void this.#start()
      })
      return
    }

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
      if (!(e instanceof RoomOpenError) || generation !== this.#generation) throw e
      this.#fail(e.reason, e.message)
      return
    }
    if (generation !== this.#generation) {
      await room.dispose()
      return
    }
    this.#mount(root, room, name)
  }

  #askName(generation: number, done: (name: string) => void): void {
    const doc = this.ownerDocument
    const form = el(doc, 'form', 'review-join')
    const label = el(doc, 'label')
    label.textContent = 'Your name '
    const input = el(doc, 'input')
    input.name = 'name'
    input.required = true
    input.maxLength = MAX_NAME
    input.autocomplete = 'off'
    label.append(input)
    const button = el(doc, 'button')
    button.type = 'submit'
    button.textContent = 'Join'
    form.append(label, button)
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const typed = input.value.trim()
      if (typed && generation === this.#generation) done(typed)
    })
    this.#root().append(form)
  }

  #mount(root: ShadowRoot, room: Room, name: string): void {
    const doc = this.ownerDocument
    const disposers = this.#disposers
    disposers.push(() => room.dispose())

    const layout = el(doc, 'div', 'review')
    const header = el(doc, 'header', 'review-header')
    const file = el(doc, 'span', 'file')
    const people = el(doc, 'div', 'people-host')
    const access = el(doc, 'span', 'access')
    const toggle = el(doc, 'button', 'comments-button')
    toggle.type = 'button'
    toggle.textContent = 'Comments'
    toggle.hidden = true
    header.append(file, people, access, toggle)
    const banner = el(doc, 'div', 'banner-slot')
    const notice = el(doc, 'div', 'notice-slot')
    const main = el(doc, 'main', 'editor')
    const source = el(doc, 'div', 'source')
    const commentsHost = el(doc, 'div', 'comments-host')
    main.append(source, commentsHost)
    layout.append(header, banner, notice, main)
    root.append(layout)
    disposers.push(() => layout.remove())

    const narrow = this.#narrow(disposers)
    const label = ACCESS_LABELS[room.access]
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
      narrow,
      prefs: null,
    })
    disposers.push(() => comments.dispose())
    disposers.push(
      mountBanner(banner, room, {
        // Leave the room and open it again from the same link.
        onReconnect: () => void this.#start(),
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
    this.#emit('pedit-status', { status: room.review.get() })
    disposers.push(room.review.subscribe((status) => this.#emit('pedit-status', { status })))
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
