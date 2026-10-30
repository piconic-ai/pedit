// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import '../src/components/Info.tsx'
import { type InfoLink, infoLinks, PUBLIC_RELAY_HOST, SOURCE_URL } from '../src/info.ts'

const mounted: HTMLElement[] = []
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove()
})

function mount(links: readonly InfoLink[]) {
  const container = document.createElement('div')
  document.body.append(container)
  mounted.push(container)
  render(container, 'Info', { links })
  const q = <T extends Element = HTMLElement>(sel: string) => {
    const el = container.querySelector<T>(sel)
    if (!el) throw new Error(`no ${sel}`)
    return el
  }
  const openPanel = () => {
    const ev = new Event('beforetoggle') as Event & { newState: string }
    ev.newState = 'open'
    q('.info').dispatchEvent(ev)
  }
  return { container, q, openPanel }
}

describe('infoLinks', () => {
  it('links the public relay’s terms, privacy policy and source, each with its own icon', () => {
    expect(new Set(infoLinks(PUBLIC_RELAY_HOST).map((l) => l.icon)).size).toBe(3)
    expect(infoLinks(PUBLIC_RELAY_HOST).map(({ label, href }) => ({ label, href }))).toEqual([
      { label: 'Terms of Use', href: '/terms' },
      { label: 'Privacy Policy', href: '/privacy' },
      { label: 'GitHub', href: SOURCE_URL },
    ])
  })

  it('links only the source on a relay someone else runs, whose operator the pages do not name', () => {
    for (const host of ['relay.example.com', 'add-terms-edit.kfly8.workers.dev', 'localhost']) {
      expect(infoLinks(host).map((l) => l.href)).toEqual([SOURCE_URL])
    }
  })
})

describe('Info', () => {
  it('opens its panel from a labelled button', () => {
    const { q } = mount(infoLinks(PUBLIC_RELAY_HOST))
    const button = q<HTMLButtonElement>('button.icon')
    expect(button.getAttribute('aria-label')).toBe('About pedit')
    expect(button.getAttribute('popovertarget')).toBe('info')
    const panel = q('.info')
    expect(panel.id).toBe('info')
    expect(panel.hasAttribute('popover')).toBe(true)
    expect(panel.getAttribute('role')).toBe('dialog')
  })

  it('shows each link with its icon and no heading, opening in a new tab so the room stays open', () => {
    const { container } = mount(infoLinks(PUBLIC_RELAY_HOST))
    const links = [...container.querySelectorAll<HTMLAnchorElement>('.info-links a')]
    expect(container.querySelector('.info h2')).toBeNull()
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Terms of Use', '/terms'],
      ['Privacy Policy', '/privacy'],
      ['GitHub', SOURCE_URL],
    ])
    for (const a of links) {
      expect(a.querySelector('svg[aria-hidden="true"] path')?.getAttribute('d')).toBeTruthy()
      expect(a.target).toBe('_blank')
      expect(a.rel.split(' ').sort()).toEqual(['noopener', 'noreferrer'])
    }
  })

  it('opens under its button, kept on screen', () => {
    const { q, openPanel } = mount(infoLinks(PUBLIC_RELAY_HOST))
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1280,
    })
    q('button.icon').getBoundingClientRect = () => ({ right: 1270, bottom: 40 }) as DOMRect
    openPanel()
    expect(q('.info').style).toMatchObject({ left: '1050px', top: '46px', width: '220px' })
  })
})
