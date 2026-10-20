// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import type { RoomStatus } from '@pedit/protocol'
import { describe, expect, it, vi } from 'vitest'
import '../src/components/EndedBanner.tsx'
import { Store } from '../src/store.ts'

function mount(props: Record<string, unknown> = {}) {
  const status = new Store<RoomStatus>('connected')
  const container = document.createElement('div')
  document.body.append(container)
  const onReconnect = vi.fn()
  render(container, 'EndedBanner', { status, text: () => 'hello', onReconnect, ...props })
  const banner = container.querySelector<HTMLElement>('.banner') as HTMLElement
  const [copy, reconnect] = [...banner.querySelectorAll('button')]
  return {
    status,
    banner,
    copy: copy as HTMLButtonElement,
    reconnect: reconnect as HTMLButtonElement,
    onReconnect,
  }
}

describe('EndedBanner', () => {
  it('shows only once the room closes', () => {
    const { status, banner, copy } = mount()
    expect(banner.hidden).toBe(true)
    status.set('closed')
    expect(banner.hidden).toBe(false)
    expect(banner.textContent).toMatch(/session has ended/)
    expect(copy.hidden).toBe(false)
  })

  it('says it waits for the host, with the text to copy and no Reconnect', () => {
    const { status, banner, copy, reconnect } = mount()
    status.set('waiting')
    expect(banner.hidden).toBe(false)
    expect(banner.textContent).toMatch(/Waiting for them to come back.*read, but not edit/)
    expect(copy.hidden).toBe(false)
    expect(reconnect.hidden).toBe(true)
    status.set('connected')
    expect(banner.hidden).toBe(true)
  })

  it('says the relay is closed for maintenance, with the text to copy and Reconnect', () => {
    const { status, banner, copy, reconnect, onReconnect } = mount()
    status.set('maintenance')
    expect(banner.hidden).toBe(false)
    expect(banner.textContent).toMatch(/closed for maintenance.*host has reconnected/)
    expect(copy.hidden).toBe(false)
    reconnect.click()
    expect(onReconnect).toHaveBeenCalled()
  })

  it('says the room reached the relay time limit, with Copy and no Reconnect', () => {
    const timeLimit = new Store<number | undefined>(86400)
    const { status, banner, copy, reconnect } = mount({ timeLimit })
    status.set('expired')
    expect(banner.hidden).toBe(false)
    expect(banner.textContent).toMatch(/reached its 24-hour limit on the relay.*new link/)
    expect(copy.hidden).toBe(false)
    expect(reconnect.hidden).toBe(true)
  })

  it('names no number when the relay did not say its time limit', () => {
    const { status, banner } = mount()
    status.set('expired')
    expect(banner.textContent).toMatch(/reached its time limit on the relay/)
  })

  it('says why a full room let nobody in, with nothing to copy', () => {
    const { status, banner, copy, reconnect } = mount()
    status.set('full')
    expect(banner.hidden).toBe(false)
    const shown = [...banner.querySelectorAll('span')].filter((s) => !s.hidden)
    expect(shown.map((s) => s.textContent)).toEqual([expect.stringMatching(/room is full/)])
    expect(copy.hidden).toBe(true)
    expect(reconnect.hidden).toBe(false)
  })

  it('asks to reload a page that is out of date', () => {
    const { status, banner, reconnect } = mount()
    status.set('client-outdated')
    expect(banner.hidden).toBe(false)
    expect(banner.textContent).toMatch(/out of date/)
    expect(reconnect.textContent).toBe('Reload')
    status.set('server-outdated')
    expect(banner.textContent).toMatch(/server is older/)
    expect(reconnect.textContent).toBe('Reconnect')
  })

  it('says the document grew too large to share, with the text to copy', () => {
    const { status, banner, copy, reconnect } = mount()
    status.set('too-large')
    expect(banner.hidden).toBe(false)
    expect(banner.textContent).toMatch(/too large to share.*about 1 MiB/)
    expect(copy.hidden).toBe(false)
    expect(reconnect.textContent).toBe('Reconnect')
  })

  it('copies the whole text and says so', async () => {
    const writeText = vi.fn(async () => {})
    const { copy } = mount({ clipboard: { writeText } })
    copy.click()
    await vi.waitFor(() => expect(copy.textContent).toBe('Copied'))
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('says when copying failed, then goes back to its label', async () => {
    vi.useFakeTimers()
    try {
      const { copy } = mount({ clipboard: undefined, resetMs: 1000 })
      copy.click()
      await vi.waitFor(() => expect(copy.textContent).toBe('Could not copy'))
      vi.advanceTimersByTime(1000)
      expect(copy.textContent).toBe('Copy text')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconnects on request', () => {
    const { reconnect, onReconnect } = mount()
    reconnect.click()
    expect(onReconnect).toHaveBeenCalledOnce()
  })
})
