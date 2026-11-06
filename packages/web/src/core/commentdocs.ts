import { checkMetaUpdate, MAX_FILES, type RoomClient } from '@pedit/protocol'
import * as Y from 'yjs'

/**
 * The comments docs this browser joins (#121), by their id in the room,
 * each update checked: anyone in the room can send one. Anyone can send a
 * list of files too, so an id it named for comments may turn out to be a
 * file's: no more are joined than a room has files, none under the id of a
 * file, one is let go when its id is taken for a file, and those the latest
 * list no longer names are let go too.
 */
export class CommentDocs {
  readonly #client: Pick<RoomClient, 'addFile' | 'removeFile'>
  readonly #docs = new Map<number, Y.Doc>()
  /** Ids taken for files, which no comments doc may have; 0 is the room's own doc. */
  readonly #files = new Set<number>([0])

  constructor(client: Pick<RoomClient, 'addFile' | 'removeFile'>) {
    this.#client = client
  }

  /** The comments doc of an id, joined the first time; null for a file's id, or past the limit. */
  docFor(metaId: number): Y.Doc | null {
    let doc = this.#docs.get(metaId)
    if (doc) return doc
    if (this.#files.has(metaId) || this.#docs.size >= MAX_FILES) return null
    doc = new Y.Doc()
    this.#client.addFile(metaId, doc, checkMetaUpdate, { comments: true })
    this.#docs.set(metaId, doc)
    return doc
  }

  /** Lets go of every comments doc but those of these ids, which the latest list names. */
  keepOnly(metaIds: ReadonlySet<number>): void {
    for (const id of [...this.#docs.keys()]) {
      if (metaIds.has(id)) continue
      this.#docs.delete(id)
      this.#client.removeFile(id)
    }
  }

  /**
   * Takes an id for a file, before the file is added under it: a comments
   * doc joined under it is let go. Returns whether one was.
   */
  takeForFile(id: number): boolean {
    this.#files.add(id)
    if (!this.#docs.delete(id)) return false
    this.#client.removeFile(id)
    return true
  }
}
