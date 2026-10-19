import { PROVIDERS, type ProviderId } from '@pedit/protocol/csp'
import { describe, expect, it } from 'vitest'
import {
  ALWAYS_LOAD_KEY,
  AlwaysLoad,
  followOtherTabs,
  isProviderId,
  loadAlwaysLoad,
  parseAlwaysLoad,
  providerLabel,
  saveAlwaysLoad,
} from '../src/alwaysload.ts'
import type { Store } from '../src/storage.ts'

function memory(initial: Record<string, string> = {}): Store & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, String(v))
    },
  }
}

const throwing: Store = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
}

describe('isProviderId', () => {
  it.each(Object.keys(PROVIDERS))('accepts the registry key %s', (id) => {
    expect(isProviderId(id)).toBe(true)
  })

  it.each([
    'YouTube',
    'dailymotion',
    'custom:https://embed.example.com',
    'custom:',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/',
    'toString',
    'constructor',
    '__proto__',
    '',
    1,
    null,
    {},
  ])('rejects %j', (id) => expect(isProviderId(id)).toBe(false))
})

describe('providerLabel', () => {
  it('names each provider by its name in the registry', () => {
    expect(providerLabel('youtube')).toBe('YouTube')
    expect(providerLabel('vimeo')).toBe('Vimeo')
    for (const [id, provider] of Object.entries(PROVIDERS)) {
      expect(providerLabel(id as ProviderId)).toBe(provider.name)
    }
  })
})

describe('parseAlwaysLoad', () => {
  it('keeps the registry keys once, in order', () => {
    expect(
      parseAlwaysLoad(['vimeo', 'bad', 'youtube', 'vimeo', 3, 'custom:https://a.example']),
    ).toEqual(['vimeo', 'youtube'])
  })

  it('drops ids this relay has no provider for, such as an older custom site', () => {
    expect(parseAlwaysLoad(['custom:https://embed.example.com', 'dailymotion', 'youtube'])).toEqual(
      ['youtube'],
    )
  })

  it.each([null, 'youtube', { youtube: true }, 42])('reads %j as nothing remembered', (value) => {
    expect(parseAlwaysLoad(value)).toEqual([])
  })
})

describe('loadAlwaysLoad and saveAlwaysLoad', () => {
  it('round-trips the ids as JSON', () => {
    const store = memory()
    saveAlwaysLoad(['youtube', 'vimeo'], store)
    expect(store.data.get(ALWAYS_LOAD_KEY)).toBe('["youtube","vimeo"]')
    expect(loadAlwaysLoad(store)).toEqual(['youtube', 'vimeo'])
  })

  it('drops stored ids this relay has no provider for on read', () => {
    const store = memory({ [ALWAYS_LOAD_KEY]: '["custom:https://embed.example.com","vimeo"]' })
    expect(loadAlwaysLoad(store)).toEqual(['vimeo'])
  })

  it('never stores anything but provider ids', () => {
    const store = memory()
    saveAlwaysLoad(['youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ#key' as never], store)
    expect(store.data.get(ALWAYS_LOAD_KEY)).toBe('["youtube"]')
  })

  it.each(['not json', '{"youtube":true}', '"youtube"', '[1,"https://evil.example/"]'])(
    'reads a malformed value %j as nothing remembered',
    (raw) => {
      expect(loadAlwaysLoad(memory({ [ALWAYS_LOAD_KEY]: raw }))).toEqual([])
    },
  )

  it('remembers nothing without storage, or when it throws', () => {
    expect(loadAlwaysLoad(null)).toEqual([])
    expect(loadAlwaysLoad(throwing)).toEqual([])
    expect(saveAlwaysLoad(['youtube'], null)).toBe(false)
    expect(saveAlwaysLoad(['youtube'], throwing)).toBe(false)
    expect(saveAlwaysLoad(['youtube'], memory())).toBe(true)
  })
})

describe('AlwaysLoad', () => {
  it('starts from what this browser stored', () => {
    const always = new AlwaysLoad(memory({ [ALWAYS_LOAD_KEY]: '["vimeo","x"]' }))
    expect(always.ids.get()).toEqual(['vimeo'])
    expect(always.has('vimeo')).toBe(true)
    expect(always.has('youtube')).toBe(false)
    expect(always.has(null)).toBe(false)
  })

  it('stores each change and publishes only when the list changes', () => {
    const store = memory()
    const always = new AlwaysLoad(store)
    const seen: (readonly string[])[] = []
    always.ids.subscribe((ids) => seen.push(ids))
    always.remember('youtube')
    always.remember('youtube')
    always.remember('https://evil.example/' as never)
    always.remember('custom:https://embed.example.com' as never)
    always.forget('vimeo')
    always.remember('vimeo')
    always.forget('youtube')
    expect(seen).toEqual([['youtube'], ['youtube', 'vimeo'], ['vimeo']])
    expect(store.data.get(ALWAYS_LOAD_KEY)).toBe('["vimeo"]')
  })

  it('leaves out stored ids it has no provider for, and stores the list without them', () => {
    const store = memory({ [ALWAYS_LOAD_KEY]: '["custom:https://embed.example.com","youtube"]' })
    const always = new AlwaysLoad(store)
    expect(always.ids.get()).toEqual(['youtube'])
    expect(always.has('custom:https://embed.example.com' as never)).toBe(false)
    always.remember('vimeo')
    expect(store.data.get(ALWAYS_LOAD_KEY)).toBe('["youtube","vimeo"]')
  })

  it('leaves out an unknown id another tab stored when taking in its change', () => {
    const store = memory({ [ALWAYS_LOAD_KEY]: '["youtube"]' })
    const always = new AlwaysLoad(store)
    const seen: (readonly string[])[] = []
    always.ids.subscribe((ids) => seen.push(ids))
    store.setItem(ALWAYS_LOAD_KEY, '["youtube","custom:https://embed.example.com"]')
    always.refresh()
    expect(seen).toEqual([])
    store.setItem(ALWAYS_LOAD_KEY, '["dailymotion","vimeo"]')
    always.refresh()
    expect(seen).toEqual([['vimeo']])
  })

  it('works for the page when storage is unavailable', () => {
    const always = new AlwaysLoad(throwing)
    expect(always.ids.get()).toEqual([])
    always.remember('vimeo')
    expect(always.has('vimeo')).toBe(true)
    expect(new AlwaysLoad(throwing).has('vimeo')).toBe(false)
  })

  it("keeps this page's choice when storage reads but refuses writes (full, or private mode)", () => {
    const data = new Map<string, string>()
    const full: Store = {
      getItem: (k) => data.get(k) ?? null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    const always = new AlwaysLoad(full)
    always.remember('youtube')
    always.remember('vimeo')
    expect(always.ids.get()).toEqual(['youtube', 'vimeo'])
    // What another tab stores no longer takes this page's choice away.
    data.set(ALWAYS_LOAD_KEY, '[]')
    always.refresh()
    expect(always.ids.get()).toEqual(['youtube', 'vimeo'])
    always.forget('youtube')
    expect(always.ids.get()).toEqual(['vimeo'])
  })

  it('starts each change from what other tabs stored, so a forgotten provider stays forgotten', () => {
    const store = memory({ [ALWAYS_LOAD_KEY]: '["youtube"]' })
    const a = new AlwaysLoad(store)
    const b = new AlwaysLoad(store)
    a.forget('youtube')
    b.remember('vimeo')
    expect(loadAlwaysLoad(store)).toEqual(['vimeo'])
    expect(b.ids.get()).toEqual(['vimeo'])
    a.remember('youtube')
    b.forget('vimeo')
    expect(loadAlwaysLoad(store)).toEqual(['youtube'])
  })

  it("takes in another tab's change on refresh, publishing only when it differs", () => {
    const store = memory({ [ALWAYS_LOAD_KEY]: '["youtube"]' })
    const a = new AlwaysLoad(store)
    const b = new AlwaysLoad(store)
    const seen: (readonly string[])[] = []
    b.ids.subscribe((ids) => seen.push(ids))
    a.forget('youtube')
    b.refresh()
    b.refresh()
    expect(b.has('youtube')).toBe(false)
    expect(seen).toEqual([[]])
  })
})

describe('followOtherTabs', () => {
  function storageEvent(key: string | null): Event {
    return Object.assign(new Event('storage'), { key })
  }

  it('refreshes on a storage event for its key, or for cleared storage, and on no other', () => {
    const store = memory({ [ALWAYS_LOAD_KEY]: '["youtube"]' })
    const always = new AlwaysLoad(store)
    const target = new EventTarget()
    followOtherTabs(always, target as unknown as Window)
    store.setItem(ALWAYS_LOAD_KEY, '["vimeo"]')
    target.dispatchEvent(storageEvent('pedit:theme'))
    expect(always.ids.get()).toEqual(['youtube'])
    target.dispatchEvent(storageEvent(ALWAYS_LOAD_KEY))
    expect(always.ids.get()).toEqual(['vimeo'])
    store.data.clear()
    target.dispatchEvent(storageEvent(null))
    expect(always.ids.get()).toEqual([])
  })
})
