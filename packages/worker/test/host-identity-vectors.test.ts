import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import vectors from '../../testdata/host-identity-vectors.json'
import { KeptAdmission } from '../src/kept-admission.ts'
import type { Room } from '../src/room.ts'
import { roomIdFor } from '../src/room-identity.ts'

describe('host identity interoperability', () => {
  it('matches the room ID used by the host credential store', async () => {
    for (const vector of vectors) {
      expect(await roomIdFor(vector.hostToken)).toBe(vector.roomId)
      const stub = env.ROOM.get(env.ROOM.idFromName(vector.roomId))
      await runInDurableObject(stub, async (_: Room, state) => {
        const admission = new KeptAdmission(state, env.ROOM)
        await expect(
          admission.authenticateHost(vector.roomId, vector.hostToken),
        ).resolves.toBeUndefined()
        await expect(
          admission.authenticateHost(vector.roomId, `${vector.hostToken.slice(0, 42)}A`),
        ).rejects.toThrow()
      })
    }
  })
})
