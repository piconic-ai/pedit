// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import type { RoomStatus } from '@pedit/protocol'
import { describe, expect, it } from 'vitest'
import '../src/components/EndedBanner.tsx'
import '../src/components/RoomStatusIndicator.tsx'
import { whyNoImages } from '../src/attachments.ts'
import { AwayView, isHostAway, isLocked } from '../src/keptaway.ts'
import { Store } from '../src/store.ts'

const UNTIL = Date.UTC(2030, 0, 2, 3, 4, 5)

function mount() {
  const away = new AwayView(() => UNTIL)
  const status = new Store<RoomStatus>('connected')
  const [header, ended] = [document.createElement('div'), document.createElement('div')]
  document.body.append(header, ended)
  render(header, 'RoomStatusIndicator', { status: away.header, hostAway: away.hostAway })
  render(ended, 'EndedBanner', {
    status,
    text: () => '',
    keptUntil: away.until,
    skipped: away.skipped,
    onReconnect: () => {},
  })
  const set = (s: RoomStatus) => {
    status.set(s)
    away.show(s)
  }
  return {
    away,
    set,
    button: header.querySelector('.status') as HTMLElement,
    banner: ended.querySelector('.banner') as HTMLElement,
  }
}

describe('editing while the host is away', () => {
  it('locks the editor for the grace period and a full log, not for a kept room', () => {
    expect(isLocked('waiting')).toBe(true)
    expect(isLocked('log-full')).toBe(true)
    expect(isLocked('expired')).toBe(true)
    expect(isLocked('kept')).toBe(false)
    expect(isLocked('connected')).toBe(false)
    expect(isHostAway('kept')).toBe(true)
    expect(isHostAway('connected')).toBe(false)
  })

  it('lets images in while the relay keeps the room', () => {
    expect(whyNoImages('kept', false, null)).toBeNull()
    expect(whyNoImages('log-full', false, null)).toMatch(/cannot keep more/)
    expect(whyNoImages('waiting', true, null)).toMatch(/host is away/)
  })

  it('says in the header that the host is away and the edits are kept, and until when', () => {
    const x = mount()
    x.set('kept')
    expect(x.button.dataset.host).toBe('away')
    expect(x.button.getAttribute('aria-label')).toMatch(/host is away.*Edits kept/)
    expect(x.banner.hidden).toBe(false)
    expect(x.banner.textContent).toContain('The host is away')
    expect(x.banner.textContent).toContain(new Date(UNTIL).toLocaleString())
    expect(x.banner.textContent).toContain('your edits are kept')
    x.set('connected')
    expect(x.button.dataset.host).toBe('online')
    expect(x.banner.hidden).toBe(true)
  })

  it('shows edits the relay has not logged yet as sending, and kept once it has', () => {
    const x = mount()
    x.set('kept')
    expect(x.button.dataset.status).toBe('kept')
    x.away.setPending(true)
    expect(x.button.dataset.status).toBe('saving')
    expect(x.button.querySelector('.status-label')?.textContent).toMatch(/Sending/)
    x.away.setPending(false)
    expect(x.button.dataset.status).toBe('kept')
  })

  it('counts the kept edits that did not hold in the banner', () => {
    const x = mount()
    x.set('kept')
    x.away.skipped.set(2)
    expect(x.banner.textContent).toContain('Skipped invalid updates: 2')
  })

  it('says a full log in the header and the banner', () => {
    const x = mount()
    x.set('log-full')
    expect(x.button.dataset.status).toBe('log-full')
    expect(x.banner.textContent).toMatch(/cannot keep more edits/)
  })

  it('asks before the page is closed with edits the relay has not logged', () => {
    const away = new AwayView(() => UNTIL)
    const quiet = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    away.warn(quiet)
    expect(quiet.defaultPrevented).toBe(false)
    away.setPending(true)
    const loud = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    away.warn(loud)
    expect(loud.defaultPrevented).toBe(true)
    away.setPending(false)
    const after = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    away.warn(after)
    expect(after.defaultPrevented).toBe(false)
  })
})
