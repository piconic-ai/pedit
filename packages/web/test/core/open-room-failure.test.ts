import { editKeys, TEST_ROOM } from '@pedit/protocol/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'

vi.mock('@pedit/protocol', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pedit/protocol')>()),
  deriveBlobKeys: vi.fn().mockRejectedValue(new Error('no blob keys')),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('openRoom when it fails after making the awareness', () => {
  it('destroys the awareness, and its timer, before rethrowing', async () => {
    vi.useFakeTimers()
    const { openRoom } = await import('../../src/core/open-room.ts')
    const destroy = vi.spyOn(Awareness.prototype, 'destroy')
    const keys = await editKeys()
    await expect(
      openRoom({
        relay: new URL('https://relay.test'),
        roomId: TEST_ROOM,
        fragment: keys.fragments.edit as string,
        me: { name: 'Guest' },
      }),
    ).rejects.toThrow('no blob keys')
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
