import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { deriveKeptRoomKeys, parseKeptFragment } from '../../protocol/src/kept-access.ts'
import { KeptAttachmentClient } from '../../protocol/src/kept-attachment-client.ts'
import access from '../../testdata/kept-access-vectors.json'
import type { KeptSweepShard } from '../src/kept-sweep-shard.ts'
import { KeptTransport } from '../src/kept-transport.ts'
import { roomIdFor } from '../src/room-identity.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

for (const recover of [true, false]) {
  it(recover
    ? 'retries a busy registry with identical ciphertext until the Room stores it'
    : 'stops retrying registry busy at the client deadline', async () => {
    const host = token(),
      id = await roomIdFor(host)
    const keys = await deriveKeptRoomKeys(parseKeptFragment(access.edit)!, id)
    const room = env.ROOM.get(env.ROOM.idFromName(id))
    await runInDurableObject(room, async (instance, state) => {
      const transport = new KeptTransport(
        state,
        env.ROOM,
        { bytes: 100, frames: 10 },
        { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
      )
      await transport.initialize(
        id,
        host,
        {
          editor: keys.editAdmission!,
          commenter: keys.commentAdmission!,
          reader: keys.readAdmission,
        },
        'epoch',
        Uint8Array.of(1).buffer,
      )
      const original = instance['env']
      const registry = (original as Env & { KEPT_SWEEP: DurableObjectNamespace<KeptSweepShard> })
        .KEPT_SWEEP
      let registrations = 0
      const fake = {
        getByName: (name: string) => ({
          register: async (roomId: string) => {
            registrations++
            if (!recover || registrations <= 2) throw new Error('registry busy')
            await registry.getByName(name).register(roomId)
          },
        }),
      }
      instance['env'] = { ...original, KEPT_SWEEP: fake } as unknown as Env
      const bodies: Uint8Array[] = []
      const statuses: number[] = []
      const fetcher: typeof fetch = async (input, init) => {
        const req = new Request(input, init)
        bodies.push(new Uint8Array(await req.clone().arrayBuffer()))
        const response = await instance.fetch(req)
        statuses.push(response.status)
        return response
      }
      const client = new KeptAttachmentClient({
        url: 'https://room',
        keys,
        fetch: fetcher,
        timeoutMs: recover ? 5000 : 750,
      })
      try {
        if (recover) {
          const result = await client.upload(new TextEncoder().encode('attachment'))
          expect(result.disposition).toBe('stored')
          expect(statuses).toEqual([503, 503, 204])
          expect(registrations).toBe(3)
          expect(state.storage.sql.exec('SELECT * FROM kept_blob_puts').toArray()).toHaveLength(1)
        } else {
          await expect(client.upload(new TextEncoder().encode('attachment'))).rejects.toThrow(
            'interrupted',
          )
          expect(statuses.length).toBeGreaterThan(1)
          expect(statuses.every((status) => status === 503)).toBe(true)
          expect(state.storage.sql.exec('SELECT * FROM kept_blob_puts').toArray()).toHaveLength(0)
        }
        expect(bodies.length).toBeGreaterThan(1)
        for (const body of bodies.slice(1)) expect(body).toEqual(bodies[0])
      } finally {
        instance['env'] = original
      }
    })
  }, 10000)
}

it('returns retryable status when obtaining a registry stub fails synchronously', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const keys = await deriveKeptRoomKeys(parseKeptFragment(access.edit)!, id)
  const room = env.ROOM.get(env.ROOM.idFromName(id))
  await runInDurableObject(room, async (instance, state) => {
    const transport = new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
    await transport.initialize(
      id,
      host,
      {
        editor: keys.editAdmission!,
        commenter: keys.commentAdmission!,
        reader: keys.readAdmission,
      },
      'epoch',
      Uint8Array.of(1).buffer,
    )
    const original = instance['env']
    const fake = {
      getByName: () => {
        throw new Error('transport unavailable')
      },
    }
    instance['env'] = { ...original, KEPT_SWEEP: fake } as unknown as Env
    try {
      const response = await instance.fetch(
        new Request(`https://room/internal/kept/${id}/blobs/blob000000000000000001`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${keys.editAdmission}` },
          body: Uint8Array.of(3),
        }),
      )
      expect(response.status).toBe(503)
      expect(state.storage.sql.exec('SELECT * FROM kept_blob_puts').toArray()).toHaveLength(0)
    } finally {
      instance['env'] = original
    }
  })
})
