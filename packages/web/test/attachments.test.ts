import {
  ADMISSION_HEADER,
  type Attachment,
  blobIdFor,
  contentHash,
  decryptBlob,
  deriveBlobKeys,
  encryptBlob,
  fromBase64Url,
  generateKey,
} from '@pedit/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  AttachmentError,
  Attachments,
  type AttachmentsOptions,
  hostAttachments,
  MAX_BYTES,
  whyNoImages,
} from '../src/attachments.ts'

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA'
// A PNG with a text chunk that must not reach the room.
const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...[0, 0, 0, 2],
  ...[0x74, 0x45, 0x58, 0x74],
  0x68,
  0x69,
  ...[0, 0, 0, 0], // tEXt "hi"
  ...[0, 0, 0, 0],
  ...[0x49, 0x45, 0x4e, 0x44],
  ...[0, 0, 0, 0], // IEND
])
const STRIPPED = new Uint8Array([...PNG.subarray(0, 8), ...PNG.subarray(22)])

async function setup(statuses: number[] = [201], opts: Partial<AttachmentsOptions> = {}) {
  const keys = await deriveBlobKeys(fromBase64Url(generateKey()))
  const sent: Attachment[] = []
  const requests: { url: string; body: Uint8Array }[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get(ADMISSION_HEADER)).toBe(keys.admission)
    expect(init?.redirect).toBe('error')
    requests.push({ url: String(url), body: init?.body as Uint8Array })
    return new Response(null, { status: statuses.shift() ?? 201 })
  })
  const attachments = new Attachments({
    roomId: ROOM,
    keys,
    send: (a) => sent.push(a),
    fetch: fetch as typeof globalThis.fetch,
    retryDelayMs: 1,
    ...opts,
  })
  attachments.host = { dir: 'assets', maxBytes: 1000 }
  // Answers every announcement like a host that saves images.
  const store = () => {
    for (const a of sent.splice(0)) {
      if (a.kind === 'announce') {
        attachments.handle({ kind: 'stored', hash: a.hash, path: `assets/${a.hash}.png` })
      }
    }
  }
  return { keys, sent, requests, attachments, store }
}

// Other valid PNGs, for distinct hashes.
const PNG2 = new Uint8Array([...STRIPPED.subarray(0, 8), 0, 0, 0, 0, ...STRIPPED.subarray(8)])
const PNG3 = new Uint8Array([...PNG2.subarray(0, 8), 0, 0, 0, 0, ...PNG2.subarray(8)])

const file = (bytes: Uint8Array = PNG) => new Blob([bytes as Uint8Array<ArrayBuffer>])

describe('Attachments', () => {
  it('uploads the stripped image encrypted, announces it, and waits for the host', async () => {
    const { keys, sent, requests, attachments } = await setup()
    const upload = attachments.upload(file())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const hash = await contentHash(STRIPPED)
    expect(sent[0]).toEqual({ kind: 'announce', hash, mime: 'image/png' })
    expect(requests[0]?.url).toBe(`/api/rooms/${ROOM}/blobs/${await blobIdFor(keys, hash)}`)
    expect(await decryptBlob(keys, requests[0]?.body as Uint8Array, hash)).toEqual(STRIPPED)
    expect(attachments.uploading.get()).toBe(1)

    attachments.handle({ kind: 'stored', hash, path: `assets/${hash}.png` })
    expect(await upload).toBe(`assets/${hash}.png`)
    expect(attachments.uploading.get()).toBe(0)
  })

  it('needs a host that saves images', async () => {
    const { attachments } = await setup()
    attachments.host = null
    await expect(attachments.upload(file())).rejects.toThrow(/too old/)
  })

  it('refuses what is not an image', async () => {
    const { attachments, requests } = await setup()
    const svg = new TextEncoder().encode('<svg/>')
    await expect(attachments.upload(file(svg))).rejects.toThrow(/Only PNG, JPEG, GIF and WebP/)
    expect(requests).toHaveLength(0)
  })

  it.each([409, 503])('waits out a %i: an upload the room cannot take yet', async (status) => {
    const { attachments, requests, store } = await setup([status, status, 201])
    const upload = attachments.upload(file())
    await vi.waitFor(() => expect(requests).toHaveLength(3))
    store()
    await expect(upload).resolves.toMatch(/^assets\//)
  })

  it.each([
    [410, /ended/],
    [413, /too large/],
    [429, /cannot take more/],
    [500, /could not be uploaded/],
  ])('explains a %i from the server', async (status, message) => {
    const { attachments, sent } = await setup([status])
    await expect(attachments.upload(file())).rejects.toThrow(message)
    expect(sent).toHaveLength(0)
  })

  it('explains why the host refused', async () => {
    const { attachments, sent } = await setup()
    const upload = attachments.upload(file())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const hash = (sent[0] as { hash: string }).hash
    attachments.handle({ kind: 'rejected', hash, reason: 'quota' })
    await expect(upload).rejects.toThrow(AttachmentError)
    await expect(upload).rejects.toThrow(/cannot take more/)
  })

  it('gives up when the host does not answer', async () => {
    const { attachments } = await setup([201], { storedTimeoutMs: 20 })
    await expect(attachments.upload(file())).rejects.toThrow(/did not answer/)
    expect(attachments.uploading.get()).toBe(0)
  })

  it('announces again after reconnecting', async () => {
    const { attachments, sent } = await setup()
    const upload = attachments.upload(file())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    attachments.reconnected()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
    const hash = (sent[0] as { hash: string }).hash
    attachments.handle({ kind: 'stored', hash, path: 'assets/x.png' })
    await upload
    sent.length = 0
    attachments.reconnected()
    expect(sent).toHaveLength(0)
  })

  it('sends about the file an image was added to, again after reconnecting', async () => {
    const files: (number | undefined)[] = []
    const { attachments, sent } = await setup([201], {
      send: (a, f) => (sent.push(a), files.push(f)),
    })
    const upload = attachments.upload(file(), 7)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    attachments.reconnected()
    expect(files).toEqual([7, 7])
    attachments.handle({
      kind: 'stored',
      hash: (sent[0] as { hash: string }).hash,
      path: 'assets/x.png',
    })
    await upload
  })

  it('adds the same image twice at once', async () => {
    const { attachments, sent } = await setup([201, 201])
    const first = attachments.upload(file())
    const second = attachments.upload(file())
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 20))
    // One announcement, answered once, settles both.
    expect(sent).toHaveLength(1)
    const hash = (sent[0] as { hash: string }).hash
    attachments.handle({ kind: 'stored', hash, path: `assets/${hash}.png` })
    expect(await Promise.all([first, second])).toEqual([`assets/${hash}.png`, `assets/${hash}.png`])
  })

  it('ignores answers about other images', async () => {
    const { attachments } = await setup()
    attachments.handle({ kind: 'stored', hash: '0'.repeat(32), path: 'assets/x.png' })
    attachments.handle({ kind: 'rejected', hash: '0'.repeat(32), reason: 'type' })
  })
})

describe('whyNoImages', () => {
  const host = { dir: 'assets', maxBytes: 1000 }

  it('lets images in only with a host that saves them, in an open room', () => {
    expect(whyNoImages('connected', true, host)).toBeNull()
    expect(whyNoImages('closed', true, host)).toMatch(/ended/)
    expect(whyNoImages('full', true, host)).toMatch(/full/)
    expect(whyNoImages('maintenance', true, host)).toMatch(/maintenance/)
    expect(whyNoImages('client-outdated', true, host)).toMatch(/Reload/)
    expect(whyNoImages('server-outdated', true, host)).toMatch(/server is older/)
    expect(whyNoImages('too-large', true, host)).toMatch(/too large/)
    expect(whyNoImages('expired', true, host)).toMatch(/time limit/)
    expect(whyNoImages('waiting', true, host)).toMatch(/host is away/)
    expect(whyNoImages('connected', true, null)).toMatch(/too old/)
  })

  it('does not blame the host before hearing from it', () => {
    for (const [status, hostHere] of [
      ['connecting', false],
      ['disconnected', true],
      ['connected', false],
    ] as const) {
      expect(whyNoImages(status, hostHere, null)).toMatch(/Connecting to the host/)
    }
  })
})

describe('hostAttachments', () => {
  const states = (...list: Record<string, unknown>[]) => new Map(list.map((s, i) => [i, s]))
  const editors = () => 'edit' as const

  it('reads what the host says', () => {
    expect(
      hostAttachments(
        states({ name: 'guest' }, { role: 'host', attachments: { dir: 'assets', maxBytes: 500 } }),
        editors,
      ),
    ).toEqual({ dir: 'assets', maxBytes: 500 })
  })

  it('caps the size at what the server takes', () => {
    const got = hostAttachments(
      states({ role: 'host', attachments: { dir: 'a', maxBytes: 1e12 } }),
      editors,
    )
    expect(got?.maxBytes).toBe(MAX_BYTES)
  })

  it('takes the host only from an editor', () => {
    const host = states({ role: 'host', attachments: { dir: 'assets', maxBytes: 500 } })
    for (const access of ['comment', 'read', undefined] as const) {
      expect(hostAttachments(host, () => access)).toBeNull()
    }
  })

  it('is null for older hosts and odd values', () => {
    expect(hostAttachments(states({ role: 'host' }), editors)).toBeNull()
    expect(hostAttachments(states({ name: 'guest' }), editors)).toBeNull()
    for (const attachments of [
      { dir: '../x', maxBytes: 1 },
      { dir: 'a b', maxBytes: 1 },
      { dir: 'assets', maxBytes: 0 },
      { dir: 'assets', maxBytes: '1' },
    ]) {
      expect(hostAttachments(states({ role: 'host', attachments }), editors)).toBeNull()
    }
  })
})

describe('Attachments as the preview sees them', () => {
  // A room's blob store, and a host that uploads what is wanted.
  let offline = false
  let release404 = () => {}
  async function viewer(opts: Partial<AttachmentsOptions> & { gate?: boolean } = {}) {
    offline = false
    const keys = await deriveBlobKeys(fromBase64Url(generateKey()))
    const sent: Attachment[] = []
    const blobs = new Map<string, Uint8Array>()
    const gets: string[] = []
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get(ADMISSION_HEADER)).toBe(keys.admission)
      expect(init?.redirect).toBe('error')
      if (offline) throw new TypeError('Failed to fetch')
      if (init?.method === 'PUT') {
        blobs.set(String(url), init.body as Uint8Array)
        return new Response(null, { status: 201 })
      }
      gets.push(String(url))
      // The first GET answers 404 only once released, as if slow.
      if (opts.gate && gets.length === 1) {
        await new Promise<void>((r) => {
          release404 = r
        })
        return new Response(null, { status: 404 })
      }
      const body = blobs.get(String(url))
      return body
        ? new Response(body as Uint8Array<ArrayBuffer>)
        : new Response(null, { status: 404 })
    })
    const attachments = new Attachments({
      roomId: ROOM,
      keys,
      send: (a) => sent.push(a),
      fetch: fetch as typeof globalThis.fetch,
      wantDelayMs: 1,
      ...opts,
    })
    attachments.host = { dir: 'assets', maxBytes: 1000 }
    const put = async (bytes: Uint8Array) => {
      const hash = await contentHash(bytes)
      const url = `/api/rooms/${ROOM}/blobs/${await blobIdFor(keys, hash)}`
      blobs.set(url, await encryptBlob(keys, bytes))
      return hash
    }
    return { keys, blobs, attachments, sent, gets, put }
  }

  it('fetches an image from the room and hands out its URL', async () => {
    const { attachments, put } = await viewer()
    const hash = await put(STRIPPED)
    const src = `assets/${hash}.png`
    expect(attachments.lookup(src)).toBe('loading')
    await vi.waitFor(() => expect(attachments.version.get()).toBe(1))
    const found = attachments.lookup(src)
    expect(found).toEqual({ url: expect.stringMatching(/^blob:/) })
    expect(attachments.owns((found as { url: string }).url)).toBe(true)
    expect(attachments.owns('blob:http://elsewhere/x')).toBe(false)
  })

  it('asks the host for images the room does not have, and shows them once uploaded', async () => {
    const { attachments, sent, put } = await viewer()
    const hash = await contentHash(STRIPPED)
    const other = '0'.repeat(32)
    attachments.lookup(`assets/${hash}.png`)
    attachments.lookup(`assets/${other}.jpg`)
    // Both go in one message.
    // Hashing/fetching either image may finish first; the batch is unordered.
    await vi.waitFor(() => {
      expect(sent).toEqual([{ kind: 'want', hashes: expect.arrayContaining([hash, other]) }])
      expect(sent[0]).toHaveProperty('hashes.length', 2)
    })
    expect(attachments.lookup(`assets/${hash}.png`)).toBe('loading')

    await put(STRIPPED)
    attachments.handle({ kind: 'announce', hash, mime: 'image/png' })
    await vi.waitFor(() =>
      expect(attachments.lookup(`assets/${hash}.png`)).toEqual({ url: expect.any(String) }),
    )
  })

  it('gives up on an image the host does not upload', async () => {
    const { attachments } = await viewer({ wantTimeoutMs: 10 })
    const src = `assets/${'1'.repeat(32)}.png`
    attachments.lookup(src)
    await vi.waitFor(() => expect(attachments.lookup(src)).toBeNull())
  })

  it('treats content that does not match its name as missing', async () => {
    const { keys, blobs, attachments } = await viewer()
    // Someone stored other content under this name's blob id.
    const name = '2'.repeat(32)
    const url = `/api/rooms/${ROOM}/blobs/${await blobIdFor(keys, name)}`
    blobs.set(url, await encryptBlob(keys, STRIPPED))
    const src = `assets/${name}.png`
    expect(attachments.lookup(src)).toBe('loading')
    await vi.waitFor(() => expect(attachments.lookup(src)).toBeNull())
  })

  it('shows its own uploads without fetching them', async () => {
    const { attachments, sent, gets } = await viewer()
    const upload = attachments.upload(new Blob([PNG as Uint8Array<ArrayBuffer>]))
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const hash = (sent[0] as { hash: string }).hash
    attachments.handle({ kind: 'stored', hash, path: `assets/${hash}.png` })
    await upload
    expect(attachments.lookup(`assets/${hash}.png`)).toEqual({ url: expect.any(String) })
    expect(gets).toEqual([])
  })

  it('leaves other links alone', async () => {
    const { attachments, gets } = await viewer()
    for (const src of [
      'images/0123456789abcdef0123456789abcdef.png',
      'assets/0123.png',
      'assets/0123456789abcdef0123456789abcdef.svg',
      '../assets/0123456789abcdef0123456789abcdef.png',
    ]) {
      expect(attachments.lookup(src)).toBeNull()
    }
    expect(gets).toEqual([])
  })

  it('keeps resolving links after the host leaves', async () => {
    const { attachments, put } = await viewer()
    attachments.host = { dir: 'pics', maxBytes: 1000 }
    attachments.host = null
    const hash = await put(STRIPPED)
    expect(attachments.lookup(`pics/${hash}.png`)).toBe('loading')
  })

  it('forgets images no longer on screen past its memory budget', async () => {
    const { attachments, put } = await viewer({ cacheBytes: STRIPPED.length + 10 })
    const a = await put(STRIPPED)
    const b = await put(PNG2)
    attachments.lookup(`assets/${a}.png`)
    attachments.rendered()
    await vi.waitFor(() => expect(attachments.version.get()).toBe(1))
    const first = attachments.lookup(`assets/${a}.png`) as { url: string }
    attachments.rendered()
    // The document now links only b.
    attachments.lookup(`assets/${b}.png`)
    attachments.rendered()
    await vi.waitFor(() => expect(attachments.version.get()).toBe(2))
    expect(attachments.owns(first.url)).toBe(false)
    expect(attachments.lookup(`assets/${a}.png`)).toBe('loading')
  })

  it('settles when the document shows more than its budget', async () => {
    const { attachments, put, gets } = await viewer({ cacheBytes: 1 })
    const srcs = [
      `assets/${await put(STRIPPED)}.png`,
      `assets/${await put(PNG2)}.png`,
      `assets/${await put(PNG3)}.png`,
    ]
    // Renders like the preview: every link, again on every arrival.
    const render = () => {
      for (const src of srcs) attachments.lookup(src)
      attachments.rendered()
    }
    attachments.version.subscribe(render)
    render()
    await vi.waitFor(() =>
      expect(srcs.map((src) => attachments.lookup(src))).toEqual(
        srcs.map(() => ({ url: expect.any(String) })),
      ),
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(gets).toHaveLength(3)
  })

  it('retries what failed on the way after reconnecting', async () => {
    const { attachments, put, gets } = await viewer()
    const hash = await put(STRIPPED)
    const src = `assets/${hash}.png`
    // Offline: the fetch throws.
    offline = true
    attachments.lookup(src)
    await vi.waitFor(() => expect(attachments.lookup(src)).toBeNull())
    offline = false
    // Not retried on every render.
    attachments.lookup(src)
    expect(gets).toHaveLength(0)
    attachments.reconnected()
    expect(attachments.lookup(src)).toBe('loading')
    await vi.waitFor(() => expect(attachments.lookup(src)).toEqual({ url: expect.any(String) }))
  })

  it('asks again after reconnecting for what it wanted, and retries unanswered wants', async () => {
    const { attachments, sent } = await viewer({ wantTimeoutMs: 300 })
    const hash = '3'.repeat(32)
    const src = `assets/${hash}.png`
    attachments.lookup(src)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    attachments.reconnected()
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toEqual({ kind: 'want', hashes: [hash] })
    // Unanswered: shown as missing until the next reconnect.
    await vi.waitFor(() => expect(attachments.lookup(src)).toBeNull())
    attachments.reconnected()
    expect(attachments.lookup(src)).toBe('loading')
  })

  it('looks in the room first for what it wanted, after reconnecting', async () => {
    const { attachments, sent, put } = await viewer()
    const hash = await contentHash(STRIPPED)
    const src = `assets/${hash}.png`
    attachments.lookup(src)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    // Uploaded and announced while we were offline: the announce is lost.
    await put(STRIPPED)
    attachments.reconnected()
    await vi.waitFor(() => expect(attachments.lookup(src)).toEqual({ url: expect.any(String) }))
    expect(sent).toHaveLength(1)
  })

  it('fetches again when the image is announced during its own fetch', async () => {
    const { attachments, sent, put, gets } = await viewer({ gate: true })
    const hash = await contentHash(STRIPPED)
    const src = `assets/${hash}.png`
    attachments.lookup(src)
    await vi.waitFor(() => expect(gets).toHaveLength(1))
    // Someone else's want gets it uploaded while our fetch is out.
    await put(STRIPPED)
    attachments.handle({ kind: 'announce', hash, mime: 'image/png' })
    release404()
    await vi.waitFor(() => expect(attachments.lookup(src)).toEqual({ url: expect.any(String) }))
    expect(sent).toEqual([])
  })
})
