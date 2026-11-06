// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => ({ open: undefined as undefined | (() => Promise<unknown>) }))
vi.mock('../../web/src/core/open-room.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../web/src/core/open-room.ts')>()),
  openRoom: () => core.open?.(),
}))

import { generateEditSecret } from '@pedit/protocol'
import { RoomOpenError } from '../../web/src/core/open-room.ts'
import '../src/index.ts'

afterEach(() => {
  document.body.replaceChildren()
  location.hash = ''
})

async function place() {
  location.hash = `#${'a'.repeat(22)}.${generateEditSecret()}`
  // Let the hashchange of that assignment pass before the element is there to hear it.
  await new Promise((r) => setTimeout(r, 10))
  const el = document.createElement('pedit-review')
  el.setAttribute('relay', 'https://relay.test')
  el.setAttribute('name', 'Ana')
  const errors: { reason: string; message: string }[] = []
  el.addEventListener('pedit-error', (e) => errors.push((e as CustomEvent).detail))
  document.body.append(el)
  return { el, errors }
}

describe('<pedit-review> when the room cannot be opened', () => {
  it('says open-failed in fixed words, never the error text, and does not rethrow', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    core.open = () => Promise.reject(new Error('secret-in-the-message'))
    const { el, errors } = await place()
    await vi.waitFor(() => expect(errors.length).toBe(1))
    expect(errors[0]?.reason).toBe('open-failed')
    expect(JSON.stringify(errors)).not.toContain('secret-in-the-message')
    expect(el.shadowRoot?.textContent).not.toContain('secret-in-the-message')
    await new Promise((r) => setTimeout(r, 10))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('tells the reader what an unsupported browser lacks', async () => {
    core.open = () => Promise.reject(new RoomOpenError('unsupported-browser'))
    const { errors } = await place()
    await vi.waitFor(() => expect(errors.length).toBe(1))
    expect(errors[0]).toEqual({
      reason: 'unsupported-browser',
      message: 'This browser cannot open the review: it lacks the cryptography it needs.',
    })
  })

  it('says nothing when a newer mount has taken over, whatever the error', async () => {
    let fail: (e: unknown) => void = () => {}
    core.open = () => new Promise((_, reject) => (fail = reject))
    const { el, errors } = await place()
    el.remove()
    fail(new Error('late'))
    await new Promise((r) => setTimeout(r, 20))
    expect(errors).toEqual([])
    expect(el.shadowRoot?.querySelector('[role="alert"]')).toBeNull()
  })
})
