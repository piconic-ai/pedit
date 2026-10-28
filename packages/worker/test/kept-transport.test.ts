import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  DurableLog,
  LogFrozenError,
  LogFullError,
  StaleCheckpointError,
} from '../src/durable-log.ts'
import { KeptTransport } from '../src/kept-transport.ts'
import type { Room } from '../src/room.ts'
import { roomIdFor } from '../src/room-identity.ts'
import { ADMISSION_KEY } from '../src/room-storage.ts'

const bytes = (...x: number[]) => new Uint8Array(x).buffer
const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const caps = () => ({ editor: token(), commenter: token(), reader: token() })
async function room() {
  const host = token(),
    id = await roomIdFor(host)
  return { host, id, stub: env.ROOM.get(env.ROOM.idFromName(id)) }
}
const transport = (state: DurableObjectState) =>
  new KeptTransport(state, env.ROOM, { bytes: 10, frames: 3 })

describe('kept transport', () => {
  it('authorizes initialization and append and catches up through a fixed tail', async () => {
    const r = await room(),
      c = caps()
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = transport(state)
      await expect(t.initialize(r.id, token(), c, 'first', bytes(9))).rejects.toThrow()
      await t.initialize(r.id, r.host, c, 'first', bytes(9))
      await expect(t.append(c.reader, 'first', bytes(1))).rejects.toThrow('append admission denied')
      await expect(t.beginRead(token())).rejects.toThrow('read admission denied')
      const one = await t.append(c.editor, 'first', bytes(1))
      const initial = await t.beginRead(c.reader)
      expect(new Uint8Array(initial.ciphertext)).toEqual(new Uint8Array([9]))
      const two = await t.append(c.commenter, 'first', bytes(2))
      const page = await t.readPage(c.reader, initial.session, initial.cursor)
      expect(page.entries.map((x) => x.sequence)).toEqual([one])
      expect(page.next).toBeNull()
      await t.finishRead(c.reader, initial.session, initial.cursor)
      const catchup = await t.beginRead(c.reader)
      const reread = await t.readPage(c.reader, catchup.session, catchup.cursor)
      expect(reread.entries.map((x) => x.sequence)).toEqual([one, two])
      await expect(t.freeze(r.id, c.editor, 'first', 1)).rejects.toThrow('invalid host credentials')
      const cut = await t.freeze(r.id, r.host, 'first', 1)
      expect(await t.pendingCut(r.id, r.host)).toEqual(cut)
      await expect(t.pendingCut(r.id, c.commenter)).rejects.toThrow('invalid host credentials')
      await expect(t.append(c.commenter, 'first', bytes(3))).rejects.toBeInstanceOf(LogFrozenError)
      await expect(t.commit(r.id, c.reader, cut, 'second', bytes(8))).rejects.toThrow(
        'invalid host credentials',
      )
      await t.commit(r.id, r.host, cut, 'second', bytes(8))
      await expect(t.readPage(c.reader, catchup.session, catchup.cursor)).rejects.toBeInstanceOf(
        StaleCheckpointError,
      )
      const next = await t.beginRead(c.reader)
      expect(next.generation).toBe(2)
      expect(new Uint8Array(next.ciphertext)).toEqual(new Uint8Array([8]))
      await expect(t.append(c.editor, 'first', bytes(1))).rejects.toBeInstanceOf(
        StaleCheckpointError,
      )
    })
  })

  it('rejects initialization if a v5 session opens while hashing capabilities', async () => {
    const r = await room(),
      c = caps()
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = transport(state)
      let resume!: () => void
      let entered!: () => void
      const waiting = new Promise<void>((resolve) => {
        resume = resolve
      })
      const hashing = new Promise<void>((resolve) => {
        entered = resolve
      })
      const hash = crypto.subtle.digest.bind(crypto.subtle)
      const editorBytes = new TextEncoder().encode(c.editor)
      const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, input) => {
        const view =
          input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        if (view.length === editorBytes.length && view.every((b, i) => b === editorBytes[i])) {
          entered()
          await waiting
        }
        return hash(algorithm, input)
      })
      try {
        const pending = t.initialize(r.id, r.host, c, 'first', bytes(9))
        await hashing
        state.storage.kv.put(ADMISSION_KEY, bytes(42))
        resume()
        await expect(pending).rejects.toThrow('room already used')
        expect(new Uint8Array(state.storage.kv.get<ArrayBuffer>(ADMISSION_KEY) ?? [])).toEqual(
          new Uint8Array([42]),
        )
        expect(state.storage.kv.get('keptAdmission')).toBeUndefined()
      } finally {
        resume()
        spy.mockRestore()
      }
    })
  })

  it('rejects an authorized append interrupted by close and does not reopen the old room', async () => {
    const r = await room(),
      c = caps()
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = transport(state)
      await t.initialize(r.id, r.host, c, 'first', bytes(9))
      let resume!: () => void
      let entered!: () => void
      const wait = new Promise<void>((resolve) => {
        resume = resolve
      })
      const hashing = new Promise<void>((resolve) => {
        entered = resolve
      })
      const hash = crypto.subtle.digest.bind(crypto.subtle)
      const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, input) => {
        const view =
          input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        if (view.length === 1 && view[0] === 7) {
          entered()
          await wait
        }
        return hash(algorithm, input)
      })
      try {
        const pending = t.append(c.editor, 'first', bytes(7))
        await hashing
        state.storage.kv.delete(ADMISSION_KEY)
        DurableLog.clear(state.storage)
        await expect(t.initialize(r.id, r.host, c, 'next', bytes(8))).rejects.toThrow(
          'kept admission already registered',
        )
        resume()
        await expect(pending).rejects.toThrow()
        expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toHaveLength(0)
        await expect(t.append(c.editor, 'first', bytes(1))).rejects.toThrow()
      } finally {
        resume()
        spy.mockRestore()
      }
    })
  })

  it('does not acknowledge a failed sync and retries the same ciphertext', async () => {
    const r = await room(),
      c = caps()
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = transport(state)
      await t.initialize(r.id, r.host, c, 'first', bytes(9))
      const spy = vi.spyOn(state.storage, 'sync').mockRejectedValueOnce(new Error('sync failed'))
      try {
        await expect(t.append(c.editor, 'first', bytes(1))).rejects.toThrow('sync failed')
      } finally {
        spy.mockRestore()
      }
      const sequence = await t.append(c.editor, 'first', bytes(1))
      const snapshot = await t.beginRead(c.reader)
      const page = await t.readPage(c.reader, snapshot.session, snapshot.cursor)
      expect(page.entries.map((item) => item.sequence)).toEqual([sequence])
    })
  })

  it('waits for storage sync before acknowledging and survives eviction', async () => {
    const r = await room(),
      c = caps()
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = transport(state)
      await t.initialize(r.id, r.host, c, 'first', bytes(9))
      let resume!: () => void, entered!: () => void
      const waiting = new Promise<void>((resolve) => {
        resume = resolve
      })
      const syncing = new Promise<void>((resolve) => {
        entered = resolve
      })
      const sync = state.storage.sync.bind(state.storage)
      const spy = vi.spyOn(state.storage, 'sync').mockImplementationOnce(async () => {
        entered()
        await waiting
        await sync()
      })
      let acknowledged = false
      try {
        const pending = t.append(c.editor, 'first', bytes(1)).then((seq) => {
          acknowledged = true
          return seq
        })
        await syncing
        expect(acknowledged).toBe(false)
        resume()
        expect(await pending).toBe(1)
      } finally {
        resume()
        spy.mockRestore()
      }
    })
    await evictDurableObject(r.stub)
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = transport(state)
      const snapshot = await t.beginRead(c.reader)
      const page = await t.readPage(c.reader, snapshot.session, snapshot.cursor)
      expect(page.entries.map((x) => [...new Uint8Array(x.ciphertext)])).toEqual([[1]])
      await t.append(c.commenter, 'first', bytes(2))
      await t.append(c.commenter, 'first', bytes(3))
      await expect(t.append(c.editor, 'first', bytes(4))).rejects.toBeInstanceOf(LogFullError)
      state.storage.kv.delete(ADMISSION_KEY)
      DurableLog.clear(state.storage)
      await expect(t.append(c.editor, 'first', bytes(5))).rejects.toThrow()
      await expect(t.beginRead(c.reader)).rejects.toThrow()
      await expect(t.freeze(r.id, r.host, 'first', 1)).rejects.toThrow()
    })
  })
})
