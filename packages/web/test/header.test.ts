// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import type { RoomStatus } from '@pedit/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import '../src/components/Header.tsx'
import type { Participant } from '../src/room.ts'
import { Store } from '../src/store.ts'
import { ViewSwitch } from '../src/view.ts'
import { fakeSettings } from './support/settings-model.ts'

const mounted: HTMLElement[] = []
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove()
})

function person(clientId: number, name: string, extra: Partial<Participant> = {}): Participant {
  return { clientId, name, color: '#1f7a64', isHost: false, isSelf: false, ...extra }
}

/** Counts live subscriptions: components read stores, they never subscribe. */
class Counted<T> extends Store<T> {
  active = 0
  override subscribe(fn: (value: T) => void): () => void {
    this.active++
    const stop = super.subscribe(fn)
    return () => {
      this.active--
      stop()
    }
  }
}

function mount() {
  const file = new Counted<string | null>(null)
  const status = new Counted<RoomStatus>('connecting')
  const people = new Counted<readonly Participant[]>([])
  const narrow = new Counted(false)
  const openComments = new Counted(0)
  const commentable = new Counted(false)
  const commentsOpen = new Counted(true)
  const modes: string[] = []
  const view = new ViewSwitch({ narrow: false, onApply: (m) => modes.push(m), store: null })
  const { model: settings } = fakeSettings()
  const container = document.createElement('div')
  document.body.append(container)
  mounted.push(container)
  render(container, 'Header', {
    file,
    status,
    people,
    narrow,
    view,
    settings,
    openComments,
    commentable,
    commentsOpen,
  })
  const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel)
  const list = () => q('.people') as HTMLElement
  const names = () => [...list().querySelectorAll('li')].map((li) => li.title)
  const button = (mode: string) =>
    q<HTMLButtonElement>(`[data-mode="${mode}"]`) as HTMLButtonElement
  return {
    file,
    status,
    people,
    narrow,
    view,
    modes,
    q,
    list,
    names,
    button,
    openComments,
    commentable,
    commentsOpen,
  }
}

describe('Header', () => {
  it('reads the stores without subscribing to them, so nothing can leak', () => {
    const { file, status, people, narrow, openComments, commentable, commentsOpen, q } = mount()
    const stores = [file, status, people, narrow, openComments, commentable, commentsOpen]
    expect(stores.map((s) => s.active)).toEqual([0, 0, 0, 0, 0, 0, 0])
    file.set('notes.md')
    expect(q('.file')?.textContent).toBe('notes.md')
  })

  it('counts the open comments beside the file name', () => {
    const { file, openComments, q } = mount()
    file.set('notes.md')
    const count = q('.file .comment-count') as HTMLElement
    expect(count.hidden).toBe(true)
    openComments.set(3)
    expect(count.hidden).toBe(false)
    expect(count.textContent).toBe('3')
    expect(count.title).toBe('3 open comments')
  })

  it('opens and closes the comments panel, for a file with comments', () => {
    const { commentable, commentsOpen, q } = mount()
    const toggle = q<HTMLButtonElement>('.comments-button') as HTMLButtonElement
    expect(toggle.hidden).toBe(true)
    commentable.set(true)
    expect(toggle.hidden).toBe(false)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    toggle.click()
    expect(commentsOpen.get()).toBe(false)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    toggle.click()
    expect(commentsOpen.get()).toBe(true)
  })

  it('shows pedit as a link to the landing page', () => {
    const { q } = mount()
    const brand = q<HTMLAnchorElement>('a.brand') as HTMLAnchorElement
    expect(brand.textContent?.trim()).toBe('pedit')
    expect(brand.getAttribute('href')).toBe('/')
  })

  it('shows the file name once the host tells it', () => {
    const { file, q } = mount()
    expect(q('.file')?.textContent).toBe('')
    file.set('notes.md')
    expect(q('.file')?.textContent).toBe('notes.md')
  })

  it('shows the connection status', () => {
    const { status, q } = mount()
    const el = q('.status') as HTMLElement
    expect(el.dataset.status).toBe('connecting')
    expect(el.textContent).toBe('Connecting…')
    status.set('connected')
    expect(el.dataset.status).toBe('connected')
    expect(el.textContent).toBe('Connected')
    status.set('disconnected')
    expect(el.textContent).toBe('Offline')
    status.set('busy')
    expect(el.textContent).toBe('Busy, retrying…')
    status.set('closed')
    expect(el.textContent).toBe('Ended')
    status.set('full')
    expect(el.textContent).toBe('Room full')
    status.set('maintenance')
    expect(el.textContent).toBe('Maintenance')
    status.set('client-outdated')
    expect(el.textContent).toBe('Outdated')
    status.set('server-outdated')
    expect(el.textContent).toBe('Server outdated')
    status.set('too-large')
    expect(el.textContent).toBe('Too large')
    status.set('expired')
    expect(el.textContent).toBe('Time limit')
  })

  it('lists participants with the host and you marked, and their colours', () => {
    const { people, names, list } = mount()
    people.set([
      person(1, 'Ada Lovelace', { isHost: true, color: '#b85a0e' }),
      person(2, 'Grace', { isSelf: true }),
    ])
    expect(names()).toEqual(['Ada Lovelace (host)', 'Grace (you)'])
    const first = list().querySelector('li') as HTMLElement
    expect(first.style.getPropertyValue('--c')).toBe('#b85a0e')
    expect(first.querySelector('.avatar')?.textContent).toBe('AL')
    people.set([person(2, 'Grace', { isSelf: true })])
    expect(names()).toEqual(['Grace (you)'])
  })

  it('drops an avatar image that fails to load, keeping the initials', () => {
    const { people, list } = mount()
    people.set([person(1, 'Ada', { avatar: 'https://www.gravatar.com/avatar/x?d=404' })])
    const img = list().querySelector('img') as HTMLImageElement
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
    img.dispatchEvent(new Event('error'))
    expect(list().querySelector('img')).toBeNull()
    expect(list().querySelector('.avatar')?.textContent).toBe('A')
  })

  it('counts the people past the faces a narrow row shows', () => {
    const { people, list } = mount()
    people.set([1, 2, 3].map((i) => person(i, `P${i}`)))
    expect(list().dataset.more).toBeUndefined()
    people.set([1, 2, 3, 4, 5].map((i) => person(i, `P${i}`)))
    expect(list().dataset.more).toBe('+2')
  })

  it('shows the names on a tap on narrow screens, and folds on a width change', () => {
    const { narrow, list } = mount()
    list().click()
    expect('expanded' in list().dataset).toBe(false)
    narrow.set(true)
    list().click()
    expect('expanded' in list().dataset).toBe(true)
    list().click()
    expect('expanded' in list().dataset).toBe(false)
    list().click()
    narrow.set(false)
    narrow.set(true)
    expect('expanded' in list().dataset).toBe(false)
  })

  it('draws the view buttons and switches on click', () => {
    const { view, modes, button, q } = mount()
    expect(button('editor').textContent).toBe('Edit')
    expect(button('split').getAttribute('aria-pressed')).toBe('true')
    expect(button('table').hidden).toBe(true)
    button('preview').click()
    expect(view.mode).toBe('preview')
    expect(modes.at(-1)).toBe('preview')
    expect(button('preview').getAttribute('aria-pressed')).toBe('true')
    expect(button('split').getAttribute('aria-pressed')).toBe('false')

    view.setKind('table')
    expect(button('editor').textContent).toBe('Text')
    expect(button('table').hidden).toBe(false)
    view.setTableError('line 3 is not valid CSV')
    expect(button('table').disabled).toBe(true)
    expect(button('table').title).toBe('line 3 is not valid CSV')

    view.setKind('plain')
    expect((q('.view-switch') as HTMLElement).hidden).toBe(true)
  })

  it('ends with the settings gear and its panel', () => {
    const { q } = mount()
    expect(q('header .settings-slot button.icon')?.getAttribute('aria-label')).toBe('Settings')
    expect(q('header .settings')?.hasAttribute('popover')).toBe(true)
  })
})
