import { createEffect, createRoot } from '@barefootjs/client'
import { describe, expect, it, vi } from 'vitest'
import { Store } from '../../src/core/store.ts'

describe('Store', () => {
  it('tells subscribers about each new value, until they stop', () => {
    const store = new Store(1)
    const seen = vi.fn()
    const stop = store.subscribe(seen)
    store.set(2)
    expect(store.get()).toBe(2)
    stop()
    store.set(3)
    expect(seen.mock.calls).toEqual([[2]])
  })

  it('stays quiet when the value does not change', () => {
    const store = new Store('a')
    const seen = vi.fn()
    store.subscribe(seen)
    store.set('a')
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('Store as a signal', () => {
  it('re-runs an effect that read it, and only on a real change', () => {
    const store = new Store('a')
    const seen: string[] = []
    createRoot(() => {
      createEffect(() => {
        seen.push(store.get())
      })
    })
    store.set('b')
    store.set('b')
    expect(seen).toEqual(['a', 'b'])
  })

  it('holds a function as a value, not as an update', () => {
    const fn = () => 1
    const store = new Store<() => number>(() => 0)
    store.set(fn)
    expect(store.get()).toBe(fn)
  })

  it('does not track itself when set inside an effect', () => {
    const store = new Store(0)
    let runs = 0
    createRoot(() => {
      createEffect(() => {
        runs++
        store.set(1)
      })
    })
    store.set(2)
    expect(runs).toBe(1)
  })
})
