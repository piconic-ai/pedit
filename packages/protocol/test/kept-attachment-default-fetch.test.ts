import { expect, it, vi } from 'vitest'
import fixture from '../../testdata/kept-access-vectors.json'
import { deriveKeptRoomKeys, parseKeptFragment } from '../src/kept-access.ts'
import { KeptAttachmentClient } from '../src/kept-attachment-client.ts'

it('calls the default fetch without a client receiver', async () => {
  let invoked = false
  vi.stubGlobal('fetch', function (this: unknown) {
    expect(this).toBeUndefined()
    invoked = true
    return Promise.resolve(new Response(null, { status: 403 }))
  })
  try {
    const keys = await deriveKeptRoomKeys(parseKeptFragment(fixture.edit)!, fixture.roomId)
    const client = new KeptAttachmentClient({ url: 'https://room', keys })
    await expect(client.upload(Uint8Array.of(1))).rejects.toThrow('refused')
    expect(invoked).toBe(true)
  } finally {
    vi.unstubAllGlobals()
  }
})
