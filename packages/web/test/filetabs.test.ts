// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import type { FileEntry } from '@pedit/protocol'
import { describe, expect, it } from 'vitest'
import '../src/components/FileTabs.tsx'
import { Store } from '../src/store.ts'

function mount(list: FileEntry[]) {
  const files = new Store<readonly FileEntry[]>(list)
  const current = new Store(0)
  const counts = new Store<ReadonlyMap<number, number>>(new Map())
  const opened: number[] = []
  const container = document.createElement('div')
  document.body.append(container)
  render(container, 'FileTabs', {
    files,
    current,
    counts,
    onOpen: (id: number) => opened.push(id),
  })
  const nav = container.querySelector('nav') as HTMLElement
  const buttons = () => [...nav.querySelectorAll('button')]
  return { files, current, counts, opened, nav, buttons }
}

const agenda = { id: 0, path: 'agenda.md', format: 'text' }
const spec = { id: 1, path: 'docs/spec.md', format: 'text' }

describe('FileTabs', () => {
  it('stays hidden while the room shares one file', () => {
    const { nav, files } = mount([])
    expect(nav.hidden).toBe(true)
    files.set([agenda])
    expect(nav.hidden).toBe(true)
    files.set([agenda, spec])
    expect(nav.hidden).toBe(false)
  })

  it('shows each file, marks the one on screen, and opens one on click', () => {
    const { buttons, current, opened } = mount([agenda, spec])
    expect(buttons().map((b) => b.textContent)).toEqual(['agenda.md', 'docs/spec.md'])
    expect(buttons().map((b) => b.getAttribute('aria-current'))).toEqual(['page', null])
    buttons()[1]?.click()
    expect(opened).toEqual([1])
    current.set(1)
    expect(buttons().map((b) => b.getAttribute('aria-current'))).toEqual([null, 'page'])
  })

  it('shows a name as text, never as markup', () => {
    const { buttons } = mount([
      agenda,
      { id: 2, path: '<img src=x onerror=alert(1)>.md', format: 'text' },
    ])
    expect(buttons()[1]?.textContent).toBe('<img src=x onerror=alert(1)>.md')
    expect(buttons()[1]?.querySelector('img')).toBeNull()
  })

  it('counts the open comments of each file beside its name', () => {
    const { buttons, counts } = mount([agenda, spec])
    const shown = () =>
      buttons().map((b) => {
        const c = b.querySelector<HTMLElement>('.comment-count')
        return c?.hidden ? '' : (c?.textContent ?? '')
      })
    expect(shown()).toEqual(['', ''])
    counts.set(new Map([[1, 2]]))
    expect(shown()).toEqual(['', '2'])
    counts.set(new Map([[0, 1]]))
    expect(shown()).toEqual(['1', ''])
  })
})
