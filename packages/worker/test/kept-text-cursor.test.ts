import { createExecutionContext, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import app, { roomIdFor } from '../src/index.ts'

async function room() {
  const token = () =>
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
  const host = token(),
    id = await roomIdFor(host),
    editor = token(),
    reader = token()
  const base = `https://room/api/rooms/${id}/keep`
  const send = (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(base + path, init), env, createExecutionContext())
  const auth = { Authorization: `Bearer ${host}` }
  expect(
    (
      await send('/init', {
        method: 'POST',
        headers: {
          ...auth,
          'X-Pedit-Editor': editor,
          'X-Pedit-Reader': reader,
          'X-Pedit-Keep-Seconds': '60',
        },
        body: Uint8Array.of(9),
      })
    ).status,
  ).toBe(200)
  const append = () =>
    send('/append', {
      method: 'POST',
      headers: { 'X-Pedit-Admission': editor, 'X-Pedit-Sender': 'guest' },
      body: Uint8Array.of(1),
    })
  return {
    send,
    auth,
    append,
    read: { 'X-Pedit-Admission': reader },
    object: env.ROOM.get(env.ROOM.idFromName(id)),
  }
}
it('returns only status at the tail and reloads a snapshot when compaction passes the cursor', async () => {
  const r = await room()
  for (let i = 0; i < 2; i++) expect((await r.append()).status).toBe(200)
  const response = await r.send('?after=2', { headers: r.read })
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  const status = await response.json()
  expect(status).toMatchObject({ cutoff: 0, tail: 2, entries: [] })
  expect(status).not.toHaveProperty('snapshot')
  const delta = await r.send('?after=1', { headers: r.read })
  const body = await delta.json<{ snapshot?: string; entries: { id: number }[] }>()
  expect(body.snapshot).toBeUndefined()
  expect(body.entries.map((x) => x.id)).toEqual([2])
  expect(
    (
      await r.send('/checkpoint', {
        method: 'POST',
        headers: { ...r.auth, 'X-Pedit-Cutoff': '2' },
        body: Uint8Array.of(8),
      })
    ).status,
  ).toBe(200)
  const reload = await r.send('?after=1', { headers: r.read })
  expect(await reload.json()).toMatchObject({
    cutoff: 2,
    tail: 2,
    snapshot: btoa(String.fromCharCode(8)),
    entries: [],
  })
})
it('conditionally reuses the snapshot and carries current room metadata with 304', async () => {
  const r = await room()
  const first = await r.send('?after=0', { headers: r.read })
  const etag = first.headers.get('ETag')
  expect(etag).toBeTruthy()
  await first.body?.cancel()
  expect((await r.send('/away', { method: 'POST', headers: r.auth })).status).toBe(200)
  const repeated = await r.send('?after=0', { headers: { ...r.read, 'If-None-Match': etag! } })
  expect(repeated.status).toBe(304)
  expect(repeated.headers.get('X-Pedit-Host-Away')).toBe('true')
  expect(repeated.headers.get('X-Pedit-Tail')).toBe('0')
  expect(repeated.headers.get('X-Pedit-Cutoff')).toBe('0')
  expect(Number(repeated.headers.get('X-Pedit-Keep-Until'))).toBeGreaterThan(Date.now())
  expect(await repeated.text()).toBe('')
  expect((await r.append()).status).toBe(200)
  const appended = await r.send('?after=0', { headers: { ...r.read, 'If-None-Match': etag! } })
  expect(appended.status).toBe(200)
  const appendedTag = appended.headers.get('ETag')
  expect(appendedTag).not.toBe(etag)
  expect(await appended.json()).toMatchObject({ tail: 1, entries: [{ id: 1 }] })
  expect(
    (
      await r.send('/checkpoint', {
        method: 'POST',
        headers: { ...r.auth, 'X-Pedit-Cutoff': '1' },
        body: Uint8Array.of(8),
      })
    ).status,
  ).toBe(200)
  const checkpointed = await r.send('?after=0', {
    headers: { ...r.read, 'If-None-Match': appendedTag! },
  })
  expect(checkpointed.status).toBe(200)
  expect(checkpointed.headers.get('ETag')).not.toBe(appendedTag)
  expect(await checkpointed.json()).toMatchObject({
    snapshot: btoa(String.fromCharCode(8)),
    cutoff: 1,
    tail: 1,
    entries: [],
  })
})
it('uses ciphertext bytes as the editing budget rather than stopping at 1000 tiny entries', async () => {
  const r = await room()
  await runInDurableObject(r.object, (_, state) =>
    state.storage.transactionSync(() => {
      for (let id = 1; id <= 1000; id++)
        state.storage.sql.exec(
          'INSERT INTO kept_text_log(id, body, sender) VALUES (?, ?, ?)',
          id,
          Uint8Array.of(1),
          'guest',
        )
      const kept = state.storage.kv.get<Record<string, unknown>>('keptText')!
      state.storage.kv.put('keptText', { ...kept, tail: 1000 })
    }),
  )
  expect((await r.append()).status).toBe(200)
  await runInDurableObject(r.object, (_, state) => {
    state.storage.sql.exec('DELETE FROM kept_text_log')
    for (let id = 1; id <= 4; id++)
      state.storage.sql.exec(
        'INSERT INTO kept_text_log(id, body, sender) VALUES (?, ?, ?)',
        id,
        new Uint8Array(1024 * 1024),
        'guest',
      )
  })
  expect((await r.append()).status).toBe(400)
  await runInDurableObject(r.object, (_, state) =>
    state.storage.transactionSync(() => {
      state.storage.sql.exec('DELETE FROM kept_text_log')
      for (let id = 1; id <= 10000; id++)
        state.storage.sql.exec(
          'INSERT INTO kept_text_log(id, body, sender) VALUES (?, ?, ?)',
          id,
          Uint8Array.of(1),
          'guest',
        )
      const kept = state.storage.kv.get<Record<string, unknown>>('keptText')!
      state.storage.kv.put('keptText', { ...kept, tail: 10000 })
    }),
  )
  expect((await r.append()).status).toBe(400)
})
