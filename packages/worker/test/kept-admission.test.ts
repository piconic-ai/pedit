import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { admissionProtocols } from '@pedit/protocol/admission'
import { describe, expect, it, vi } from 'vitest'
import { KEPT_ADMISSION_KEY, KeptAdmission } from '../src/kept-admission.ts'
import type { Room } from '../src/room.ts'
import { roomIdFor } from '../src/room-identity.ts'
import { ADMISSION_KEY } from '../src/room-storage.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const capabilities = () => ({ editor: token(), commenter: token(), reader: token() })
async function room() {
  const host = token()
  const id = await roomIdFor(host)
  return { host, id, stub: env.ROOM.get(env.ROOM.idFromName(id)) }
}

describe('kept admission', () => {
  it('authenticates the host, registers distinct verifiers and limits durable append', async () => {
    const r = await room()
    const caps = capabilities()
    const log = vi.spyOn(console, 'log')
    const error = vi.spyOn(console, 'error')
    try {
      await runInDurableObject(r.stub, async (_: Room, state) => {
        const admission = new KeptAdmission(state, env.ROOM)
        await expect(admission.register(r.id, token(), caps)).rejects.toThrow(
          'invalid host credentials',
        )
        expect(state.storage.kv.get(KEPT_ADMISSION_KEY)).toBeUndefined()
        await admission.register(r.id, r.host, caps)
        await admission.register(r.id, r.host, caps)
        expect(await admission.role(caps.editor)).toBe('editor')
        expect(await admission.role(caps.commenter)).toBe('commenter')
        expect(await admission.role(caps.reader)).toBe('reader')
        expect(await admission.role(token())).toBeNull()
        expect(await admission.canAppend(caps.editor)).toBe(true)
        expect(await admission.canAppend(caps.commenter)).toBe(true)
        expect(await admission.canAppend(caps.reader)).toBe(false)
        const stored = state.storage.kv.get<Record<string, ArrayBuffer>>(KEPT_ADMISSION_KEY)
        expect(stored).toBeDefined()
        for (const key of ['editor', 'commenter', 'reader'] as const) {
          const expected = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(caps[key]),
          )
          expect(new Uint8Array(stored?.[key] ?? [])).toEqual(new Uint8Array(expected))
        }
      })
      await evictDurableObject(r.stub)
      await runInDurableObject(r.stub, async (_: Room, state) => {
        const recovered = new KeptAdmission(state, env.ROOM)
        expect(await recovered.role(caps.commenter)).toBe('commenter')
        expect(await recovered.canAppend(caps.reader)).toBe(false)
      })
      const upgrade = await exports.default.fetch(`https://pedit.test/api/rooms/${r.id}/ws`, {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${r.host}`,
          'Sec-WebSocket-Protocol': admissionProtocols(caps.editor).join(', '),
        },
      })
      expect(upgrade.status).toBe(403)
      const forged = await exports.default.fetch(`https://pedit.test/api/rooms/${r.id}/ws`, {
        headers: {
          Upgrade: 'websocket',
          'X-Pedit-Host': '1',
          'Sec-WebSocket-Protocol': admissionProtocols(caps.editor).join(', '),
        },
      })
      expect(forged.status).toBe(403)
      const blob = await exports.default.fetch(
        `https://pedit.test/api/rooms/${r.id}/blobs/AAAAAAAAAAAAAAAAAAAAAA`,
        { headers: { 'X-Pedit-Admission': caps.editor } },
      )
      expect(blob.status).toBe(403)
      const output = JSON.stringify([...log.mock.calls, ...error.mock.calls])
      for (const secret of [r.host, caps.editor, caps.commenter, caps.reader])
        expect(output).not.toContain(secret)
    } finally {
      log.mockRestore()
      error.mockRestore()
    }
  })

  it('atomically accepts only one of conflicting host registrations', async () => {
    const r = await room()
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const admission = new KeptAdmission(state, env.ROOM)
      const a = capabilities(),
        b = capabilities()
      const results = await Promise.allSettled([
        admission.register(r.id, r.host, a),
        admission.register(r.id, r.host, b),
      ])
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
      const winner = results[0]?.status === 'fulfilled' ? a : b
      const loser = winner === a ? b : a
      expect(await admission.role(winner.editor)).toBe('editor')
      expect(await admission.role(winner.commenter)).toBe('commenter')
      expect(await admission.role(winner.reader)).toBe('reader')
      expect(await admission.role(loser.editor)).toBeNull()
      expect(await admission.role(loser.commenter)).toBeNull()
      expect(await admission.role(loser.reader)).toBeNull()
    })
  })

  it('does not reopen after close or report success when closed during sync', async () => {
    const r = await room()
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const admission = new KeptAdmission(state, env.ROOM)
      const caps = capabilities()
      let resume!: () => void
      let entered!: () => void
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
      try {
        const registration = admission.register(r.id, r.host, caps)
        await syncing
        state.storage.kv.delete(ADMISSION_KEY)
        resume()
        await expect(registration).rejects.toThrow('kept admission no longer active')
        expect(await admission.role(caps.commenter)).toBeNull()
        await expect(admission.register(r.id, r.host, caps)).rejects.toThrow(
          'kept admission already registered',
        )
      } finally {
        resume()
        spy.mockRestore()
      }
    })
  })

  it('rejects registration on a different object, v5 room, or duplicate capability', async () => {
    const r = await room(),
      other = await room()
    await runInDurableObject(other.stub, async (_: Room, state) => {
      await expect(
        new KeptAdmission(state, env.ROOM).register(r.id, r.host, capabilities()),
      ).rejects.toThrow()
      expect(state.storage.kv.get(KEPT_ADMISSION_KEY)).toBeUndefined()
    })
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const admission = new KeptAdmission(state, env.ROOM)
      const caps = capabilities()
      await expect(
        admission.register(r.id, r.host, { ...caps, commenter: caps.reader }),
      ).rejects.toThrow()
      state.storage.kv.put(ADMISSION_KEY, new Uint8Array([1]).buffer)
      await expect(admission.register(r.id, r.host, caps)).rejects.toThrow('room already used')
      expect(state.storage.kv.get(KEPT_ADMISSION_KEY)).toBeUndefined()
      state.storage.kv.delete(ADMISSION_KEY)
      state.storage.kv.put('openedAt', 1)
      await expect(admission.register(r.id, r.host, caps)).rejects.toThrow('room already used')
    })
  })
})
