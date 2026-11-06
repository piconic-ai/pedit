import {
  type Access,
  type CanvasMessage,
  deriveBlobKeys,
  deriveRoomKeys,
  type FileEntry,
  metaFiles,
  parseFragment,
  RoomClient,
  type RoomKeys,
  type RoomStatus,
  type SocketLike,
} from '@pedit/protocol'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { Attachments, hostAttachments, whyNoImages } from './attachments.ts'
import { CommentDocs } from './commentdocs.ts'
import { OpenCounts } from './comments.ts'
import { keepAlive } from './expiry.ts'
import { AwayView, commentsLockedFor, isLocked, keptKindFor } from './keptaway.ts'
import { NoticeBoard } from './notice.ts'
import {
  colorFor,
  colorsByName,
  type Participant,
  participants,
  roomSocketUrl,
  sanitizeUser,
  selectionTint,
} from './room.ts'
import { Store } from './store.ts'

/** Who this page is in the room, as the others see it. */
export interface RoomUser {
  name: string
  avatar?: string
  /** The Cloudflare Access account, kept visible beside a chosen name (#213). */
  account?: string
}

/** What the page says of the room, in the words of `pedit-status` (docs/design/embedding.md). */
export type ReviewStatus = 'connecting' | 'live' | 'host-away' | 'ended'

/** The `pedit-status` of a room status: reconnecting counts as connecting. */
export function reviewStatusOf(status: RoomStatus): ReviewStatus {
  switch (status) {
    case 'connected':
      return 'live'
    case 'waiting':
    case 'kept':
    case 'log-full':
      return 'host-away'
    case 'connecting':
    case 'disconnected':
    case 'busy':
      return 'connecting'
    default:
      return 'ended'
  }
}

/** Why a room could not be opened from its link. */
export class RoomOpenError extends Error {
  readonly reason: 'bad-link' | 'unsupported-browser'
  constructor(reason: 'bad-link' | 'unsupported-browser') {
    super(reason === 'bad-link' ? 'not a room link' : 'this browser cannot check signatures')
    this.name = 'RoomOpenError'
    this.reason = reason
  }
}

export interface OpenRoomOptions {
  /** The relay that serves the room (see relay.ts). */
  relay: URL
  roomId: string
  /** The link's key part: what follows `#`, without the room id. */
  fragment: string
  me: RoomUser
  /** Tests: the socket the client opens, and the fetch the attachments use. */
  createSocket?: (url: string, headers?: Record<string, string>, protocols?: string[]) => SocketLike
  fetch?: typeof fetch
}

/**
 * What a view adds to the room's own handling. Each runs where the room's
 * side effects of the event have been done, in the order the page always had.
 */
export interface RoomHooks {
  /** The status changed and the stores follow it; `wasLocked` is whether editing was locked before. */
  status(status: RoomStatus, wasLocked: boolean): void
  /** The client is connected again, after the attachments were told. */
  reconnected(): void
  /** The people were rendered; `host` is the state of the editor that speaks for the host. */
  people(host: Record<string, unknown> | undefined): void
  /** A canvas message came, about the file with this id (0 for the room's own doc). */
  canvas(file: number, message: CanvasMessage): void
  /** A list of files came and `files` holds those this version knows; `known` is that list. */
  manifest(known: FileEntry[]): void
}

export interface Room {
  keys: RoomKeys
  access: Access
  /** Editors edit the file; commenters only its comments; readers nothing. */
  writesFile: boolean
  writesComments: boolean
  doc: Y.Doc
  text: Y.Text
  awareness: Awareness
  client: RoomClient
  attachments: Attachments
  notices: NoticeBoard
  status: Store<RoomStatus>
  /** The status as `pedit-status` words it, published only when it changes. */
  review: Store<ReviewStatus>
  away: AwayView
  fileName: Store<string | null>
  people: Store<readonly Participant[]>
  /** Each name's colour in the header, for the comments of people in the room. */
  authorColors: Store<ReadonlyMap<string, string>>
  /** The relay's time limit in seconds, once it has closed an expired room. */
  timeLimit: Store<number | undefined>
  /** The room's files, once the host shares more than one (#113). */
  files: Store<readonly FileEntry[]>
  /** The id of the file on screen: the page sets it, attachments are sent about it. */
  current: Store<number>
  /** Whether comments are locked, as `commentsLocked` says. */
  locked: Store<boolean>
  /** Which file of the room holds each file's comments, and the format of each file. */
  metaOf: ReadonlyMap<number, number>
  formats: ReadonlyMap<number, string>
  openCounts: OpenCounts
  commentDocs: CommentDocs
  /** The token this link shows the relay. */
  admission: string
  editLocked(): boolean
  fileLocked(): boolean
  commentsLocked(): boolean
  /** Why images cannot be added now, or null. */
  noImages(): string | null
  hooks: Partial<RoomHooks>
  /** Sets the first status and connects; the views are in place by now. */
  connect(): void
  /** Leaves the room and stops listening. */
  dispose(): Promise<void>
}

/**
 * The room half of a page: keys from the link, the doc and awareness, the
 * client with its stores and what it does with the room's messages. It reads
 * nothing from the page; views hook into it (`hooks`) and call `connect()`
 * once they are in place, as nothing is sent before.
 */
export async function openRoom(opts: OpenRoomOptions): Promise<Room> {
  const { relay, roomId: id, me } = opts
  // What the link gives in this room (#122). A browser that cannot check
  // signatures could only show changes nobody checked.
  const link = parseFragment(opts.fragment)
  if (!link) throw new RoomOpenError('bad-link')
  let keys: RoomKeys
  try {
    keys = await deriveRoomKeys(link, id)
  } catch {
    throw new RoomOpenError('unsupported-browser')
  }
  const writesFile = keys.access === 'edit'
  const writesComments = keys.access !== 'read'
  const doc = new Y.Doc()
  const text = doc.getText('content')
  const awareness = new Awareness(doc)
  // A guest in a background tab renews only once a minute (#193).
  keepAlive(awareness)
  // Before the editor subscribes, so remote cursors never see a hostile colour.
  const sanitize = ({ added, updated }: { added: number[]; updated: number[] }) => {
    for (const id of [...added, ...updated]) {
      const state = awareness.getStates().get(id)
      if (state) sanitizeUser(state, id)
    }
  }
  awareness.on('change', sanitize)
  const color = colorFor(doc.clientID)
  awareness.setLocalState({ user: { ...me, color, colorLight: selectionTint(color) } })

  const status = new Store<RoomStatus>('connecting')
  const review = new Store<ReviewStatus>('connecting')
  // Filled in once the client exists; nothing is sent before it connects.
  let client: RoomClient | undefined
  // What the page says while the host is away.
  const away = new AwayView(() => client?.keptUntil ?? 0)
  const fileName = new Store<string | null>(null)
  const people = new Store<readonly Participant[]>([])
  const authorColors = new Store<ReadonlyMap<string, string>>(new Map())
  const timeLimit = new Store<number | undefined>(undefined)
  const files = new Store<readonly FileEntry[]>([])
  const current = new Store(0)
  // The comments of the files the host keeps them for (#121): which file of
  // the room holds each file's, and the format the host lists each in.
  const metaOf = new Map<number, number>()
  const formats = new Map<number, string>()
  // The comments of every file, each in its doc, joined as soon as the host
  // lists them: the tabs count the open threads of files not opened yet.
  // Made with the client, before anything can list a file.
  let commentDocs: CommentDocs | undefined
  const openCounts = new OpenCounts((metaId) => commentDocs?.docFor(metaId) ?? null)
  const locked = new Store(!writesComments)
  const hooks: Partial<RoomHooks> = {}

  // Editors show the relay their own token, which also lets them add images.
  const admission = keys.editAdmission ?? keys.readAdmission
  const blobKeys = await deriveBlobKeys(keys.frameSecret, admission)
  const attachments = new Attachments({
    relay,
    roomId: id,
    keys: blobKeys,
    fetch: opts.fetch,
    // The relay keeps the images while the host is away, which saves them on its return.
    kept: () => status.get() === 'kept',
    // About the file an image was added to, or the one on screen: its
    // directory on the host takes the image.
    send: (a, file = current.get()) =>
      file === 0 ? client?.sendAttachment(a) : client?.sendFileAttachment(file, a),
  })
  const notices = new NoticeBoard()

  // Nobody edits while the host is away and the relay keeps nothing (the
  // two minutes it waits for a host that dropped), nor once the room has
  // ended, nor when the relay has no more room to keep edits.
  const editLocked = () => isLocked(status.get())
  // While the host is away, a comment link comments only if the relay takes
  // comment entries (`kept comments`); a read link never does.
  const commentsLocked = () =>
    commentsLockedFor(status.get(), writesComments, writesFile, client?.keptComments ?? false)
  // What the banner says the relay keeps from this link while the host is away.
  const setKeeps = () =>
    away.keeps.set(keptKindFor(writesFile, writesComments, client?.keptComments ?? false))
  // Nor does anyone whose link is below edit, ever.
  const fileLocked = () => editLocked() || !writesFile
  const noImages = () =>
    writesFile
      ? whyNoImages(
          status.get(),
          people.get().some((p) => p.isHost),
          attachments.host,
        )
      : 'This link cannot add images.'

  // Nobody edits while the host is away and nothing keeps the edits: nobody
  // would save them. Once the room has ended, for good.
  const setStatus = (s: RoomStatus) => {
    const wasLocked = editLocked()
    status.set(s)
    review.set(reviewStatusOf(s))
    away.show(s, client?.closedByHost)
    locked.set(commentsLocked())
    setKeeps()
    hooks.status?.(s, wasLocked)
  }

  const takeManifest = (list: FileEntry[]) => {
    metaOf.clear()
    formats.clear()
    for (const [file, meta] of metaFiles(list)) metaOf.set(file, meta)
    for (const f of list) formats.set(f.id, f.format)
    // Those of a list sent before, forged or not, go: they would take the
    // places of this list's.
    commentDocs?.keepOnly(new Set(metaOf.values()))
    // Every file with comments is counted, opened or not.
    openCounts.follow(new Map([...metaOf].filter(([file]) => getsComments(formats.get(file)))))
    // A file of a format this version does not know is left out, and so is
    // the metadata of a file, shown with it.
    const known = list.filter((f) => f.format === 'text' || f.format === 'canvas')
    files.set(known)
    hooks.manifest?.(known)
  }

  const renderPeople = () => {
    const accessOf = (clientId: number) => client?.accessOf(clientId)
    people.set(participants(awareness.getStates(), doc.clientID, accessOf))
    const colors = colorsByName(people.get())
    if (!sameColors(colors, authorColors.get())) authorColors.set(colors)
    attachments.host = hostAttachments(awareness.getStates(), accessOf)
    // Only an editor's state speaks for the host: anyone can say they are.
    const host = [...awareness.getStates()].find(
      ([id, s]) => s.role === 'host' && accessOf(id) === 'edit',
    )?.[1]
    hooks.people?.(host)
  }

  const rc = new RoomClient({
    url: roomSocketUrl(relay, id),
    keys,
    admissionToken: admission,
    doc,
    awareness,
    createSocket: opts.createSocket,
    onKeptSync: (state) => {
      away.setPending(state === 'pending')
    },
    onKeptSkipped: (count) => away.skipped.set(count),
    onKeptComments: () => {
      locked.set(commentsLocked())
      setKeeps()
    },
    onStatus: (s) => {
      if (s === 'expired') timeLimit.set(client?.timeLimitSeconds)
      setStatus(s)
      renderPeople()
      if (s === 'connected') {
        attachments.reconnected()
        hooks.reconnected?.()
      }
    },
    onAttachment: (a) => attachments.handle(a),
    onCanvas: (m) => hooks.canvas?.(0, m),
    onManifest: takeManifest,
    // A peer's state may stay the same while what it may do rises.
    onAccess: renderPeople,
    onFileAttachment: (_, a) => attachments.handle(a),
    onFileCanvas: (fileId, m) => hooks.canvas?.(fileId, m),
  })
  client = rc
  commentDocs = new CommentDocs(rc)
  awareness.on('change', renderPeople)

  return {
    keys,
    access: keys.access,
    writesFile,
    writesComments,
    doc,
    text,
    awareness,
    client: rc,
    attachments,
    notices,
    status,
    review,
    away,
    fileName,
    people,
    authorColors,
    timeLimit,
    files,
    current,
    locked,
    metaOf,
    formats,
    openCounts,
    commentDocs,
    admission,
    editLocked,
    fileLocked,
    commentsLocked,
    noImages,
    hooks,
    connect() {
      setStatus('connecting')
      rc.connect()
      renderPeople()
    },
    async dispose() {
      awareness.off('change', renderPeople)
      awareness.off('change', sanitize)
      notices.dismiss()
      await rc.destroy()
      awareness.destroy()
    },
  }
}

/** Whether files of a format get comments: text files and canvases. */
export function getsComments(format: string | undefined): boolean {
  return format === 'text' || format === 'canvas'
}

/** Whether two maps of names to colours hold the same. */
function sameColors(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}
