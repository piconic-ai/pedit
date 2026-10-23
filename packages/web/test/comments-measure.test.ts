import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

// Counts how often the comments are measured, and makes each take 100ms.
const measured = vi.hoisted(() => ({ count: 0 }))
vi.mock('@pedit/protocol', async (load) => {
  const real = await load<typeof import('@pedit/protocol')>()
  return {
    ...real,
    metaUse: (doc: Y.Doc) => {
      measured.count++
      clock.now += 100
      return real.metaUse(doc)
    },
  }
})
const clock = vi.hoisted(() => ({ now: 0 }))

const { CommentsView } = await import('../src/comments.ts')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('measuring the comments', () => {
  it('takes no more than a quarter of the time, and catches up after', () => {
    vi.useFakeTimers()
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
    const meta = new Y.Doc()
    const content = new Y.Doc()
    content.getText('content').insert(0, 'hello world')
    const view = new CommentsView(meta, content, { name: () => 'Ada', delayMs: 0 })
    expect(measured.count).toBe(1)
    // A peer's changes, one after another: measured no sooner than 3 × 100ms later.
    meta.getMap('comments').set('x', 1)
    view.refresh()
    clock.now += 50
    meta.getMap('comments').set('y', 2)
    view.refresh()
    expect(measured.count).toBe(1)
    clock.now += 250
    vi.advanceTimersByTime(300)
    expect(measured.count).toBe(2)
    // A comment of one's own is measured first, whatever the time.
    meta.getMap('comments').set('z', 3)
    view.start(0, 5, 'mine')
    expect(measured.count).toBe(3)
    view.destroy()
  })
})
