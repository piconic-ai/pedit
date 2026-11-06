// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import { describe, expect, it, vi } from 'vitest'
import '../../src/core/components/Notice.tsx'
import { NoticeBoard } from '../../src/core/notice.ts'
import { Store } from '../../src/core/store.ts'

function mount() {
  const board = new NoticeBoard(1000)
  const uploading = new Store(0)
  const container = document.createElement('div')
  document.body.append(container)
  render(container, 'Notice', {
    message: board.message,
    uploading,
    onDismiss: () => board.dismiss(),
  })
  const notice = container.querySelector<HTMLElement>('.notice') as HTMLElement
  const dismiss = notice.querySelector('button') as HTMLButtonElement
  return { board, uploading, notice, dismiss }
}

describe('Notice', () => {
  it('stays hidden while there is nothing to say', () => {
    expect(mount().notice.hidden).toBe(true)
  })

  it('says an image is being added', () => {
    const { uploading, notice, dismiss } = mount()
    uploading.set(1)
    expect(notice.hidden).toBe(false)
    expect(notice.textContent).toContain('Adding image…')
    expect(dismiss.hidden).toBe(true)
    uploading.set(0)
    expect(notice.hidden).toBe(true)
  })

  it('shows a message until dismissed', () => {
    const { board, notice, dismiss } = mount()
    board.show('The image is too large to add.')
    expect(notice.hidden).toBe(false)
    expect(notice.textContent).toContain('too large')
    dismiss.click()
    expect(notice.hidden).toBe(true)
  })
})

describe('NoticeBoard', () => {
  it('hides a message after a while, counting from the latest', () => {
    vi.useFakeTimers()
    try {
      const board = new NoticeBoard(1000)
      board.show('one')
      vi.advanceTimersByTime(600)
      board.show('two')
      vi.advanceTimersByTime(600)
      expect(board.message.get()).toBe('two')
      vi.advanceTimersByTime(400)
      expect(board.message.get()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
