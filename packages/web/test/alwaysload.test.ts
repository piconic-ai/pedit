import { describe, expect, it } from 'vitest'
import {
  ALWAYS_LOAD_KEY,
  AlwaysLoad,
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
  it.each(['youtube', 'vimeo', 'custom:https://embed.example.com', 'custom:http://localhost:8080'])(
    'accepts %s',
    (id) => expect(isProviderId(id)).toBe(true),
  )

  it.each([
    'YouTube',
    'custom:',
    'custom:https://embed.example.com/',
    'custom:https://embed.example.com/v/1',
    'custom:https://embed.example.com?x=1',
    'custom:https://embed.example.com#k',
    'custom:https://u:p@embed.example.com',
    'custom:javascript:alert(1)',
    'custom:blob:https://embed.example.com/x',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'toString',
    'constructor',
    1,
    null,
    {},
  ])('rejects %j', (id) => expect(isProviderId(id)).toBe(false))
})

describe('providerLabel', () => {
  it('names known providers and a custom site by its host', () => {
    expect(providerLabel('youtube')).toBe('YouTube')
    expect(providerLabel('vimeo')).toBe('Vimeo')
    expect(providerLabel('custom:https://embed.example.com:8443')).toBe('embed.example.com:8443')
  })

  it('spells out plain HTTP', () => {
    expect(providerLabel('custom:http://embed.example.com')).toBe('http://embed.example.com')
  })
})

describe('parseAlwaysLoad', () => {
  it('keeps the valid ids once, in order', () => {
    expect(
      parseAlwaysLoad(['vimeo', 'bad', 'youtube', 'vimeo', 3, 'custom:https://a.example']),
    ).toEqual(['vimeo', 'youtube', 'custom:https://a.example'])
  })

  it.each([null, 'youtube', { youtube: true }, 42])('reads %j as nothing remembered', (value) => {
    expect(parseAlwaysLoad(value)).toEqual([])
  })
})

describe('loadAlwaysLoad and saveAlwaysLoad', () => {
  it('round-trips the ids as JSON', () => {
    const store = memory()
    saveAlwaysLoad(['youtube', 'custom:https://embed.example.com'], store)
    expect(store.data.get(ALWAYS_LOAD_KEY)).toBe('["youtube","custom:https://embed.example.com"]')
    expect(loadAlwaysLoad(store)).toEqual(['youtube', 'custom:https://embed.example.com'])
  })

  it('never stores anything but provider ids', () => {
    const store = memory()
    saveAlwaysLoad(['youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ#key'], store)
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
    expect(() => saveAlwaysLoad(['youtube'], null)).not.toThrow()
    expect(() => saveAlwaysLoad(['youtube'], throwing)).not.toThrow()
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
    always.remember('https://evil.example/')
    always.forget('vimeo')
    always.remember('custom:https://embed.example.com')
    always.forget('youtube')
    expect(seen).toEqual([
      ['youtube'],
      ['youtube', 'custom:https://embed.example.com'],
      ['custom:https://embed.example.com'],
    ])
    expect(store.data.get(ALWAYS_LOAD_KEY)).toBe('["custom:https://embed.example.com"]')
  })

  it('works for the page when storage is unavailable', () => {
    const always = new AlwaysLoad(throwing)
    expect(always.ids.get()).toEqual([])
    always.remember('vimeo')
    expect(always.has('vimeo')).toBe(true)
    expect(new AlwaysLoad(throwing).has('vimeo')).toBe(false)
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
