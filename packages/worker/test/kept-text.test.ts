import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import app, { roomIdFor } from '../src/index.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
it('applies creation and request limits even to a directly minted host token', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const request = () =>
    new Request(`https://room/api/rooms/${id}/keep/init`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${host}` },
      body: Uint8Array.of(1),
    })
  const deny = { limit: async () => ({ success: false }) }
  expect(
    (await app.fetch(request(), { ...env, ROOM_CREATION_LIMIT: deny }, createExecutionContext()))
      .status,
  ).toBe(429)
  expect(
    (await app.fetch(request(), { ...env, KEEP_REQUEST_LIMIT: deny }, createExecutionContext()))
      .status,
  ).toBe(429)
})
it('keeps editor admission distinct from reader admission and truncates only an acknowledged prefix', async () => {
  const host = token(),
    id = await roomIdFor(host),
    editor = token(),
    reader = token()
  const base = `https://room/api/rooms/${id}/keep`
  const send = (action: string, init: RequestInit = {}) =>
    app.fetch(new Request(base + action, init), env, createExecutionContext())
  const auth = { Authorization: `Bearer ${host}` }
  const initialized = await send('/init', {
    method: 'POST',
    headers: {
      ...auth,
      'X-Pedit-Editor': editor,
      'X-Pedit-Reader': reader,
      'X-Pedit-Keep-Seconds': '999999',
    },
    body: Uint8Array.of(9),
  })
  expect(initialized.status).toBe(200)
  expect((await initialized.json<{ keepSeconds: number }>()).keepSeconds).toBe(604800)
  expect((await send('/away', { method: 'POST', headers: auth })).status).toBe(200)
  const away = await send('', { headers: auth })
  expect((await away.json<{ hostAway: boolean }>()).hostAway).toBe(true)
  expect((await send('/connect', { method: 'POST', headers: auth })).status).toBe(200)
  const connected = await send('', { headers: { 'X-Pedit-Admission': reader } })
  expect((await connected.json<{ hostAway: boolean }>()).hostAway).toBe(false)
  expect((await send('/checkpoint', { headers: auth })).status).toBe(403)
  expect(
    (
      await send('/append', {
        method: 'POST',
        headers: { 'X-Pedit-Admission': reader, 'X-Pedit-Sender': 'guest' },
        body: Uint8Array.of(1),
      })
    ).status,
  ).toBe(403)
  for (const n of [1, 2])
    expect(
      (
        await send('/append', {
          method: 'POST',
          headers: { 'X-Pedit-Admission': editor, 'X-Pedit-Sender': 'guest' },
          body: Uint8Array.of(n),
        })
      ).status,
    ).toBe(200)
  expect(
    (
      await send('/checkpoint', {
        method: 'POST',
        headers: { ...auth, 'X-Pedit-Cutoff': '1' },
        body: Uint8Array.of(8),
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await send('/append', {
        method: 'POST',
        headers: { 'X-Pedit-Admission': editor, 'X-Pedit-Sender': 'guest' },
        body: new Uint8Array(1024 * 1024 + 1),
      })
    ).status,
  ).toBe(400)
  const response = await send('', { headers: { 'X-Pedit-Admission': reader } })
  expect(response.status).toBe(200)
  const data = await response.json<{ snapshot: string; entries: { id: number }[]; tail: number }>()
  expect(data.snapshot).toBe(btoa(String.fromCharCode(8)))
  expect(data.entries.map((row) => row.id)).toEqual([2])
  expect(data.tail).toBe(2)
  expect(
    (
      await send('/checkpoint', {
        method: 'POST',
        headers: { ...auth, 'X-Pedit-Cutoff': '0' },
        body: Uint8Array.of(7),
      })
    ).status,
  ).toBe(400)
})
