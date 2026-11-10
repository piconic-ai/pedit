import { createExecutionContext, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { admissionProtocols, READ_ADMISSION_HEADER } from '@pedit/protocol/admission'
import { describe, expect, it } from 'vitest'
import { base64url, newHostToken, OPEN_WINDOW_MS, verifyHostToken } from '../src/host-token.ts'
import app, { roomIdFor } from '../src/index.ts'

// Public fixtures, not deployment secrets.
const SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const PREVIOUS = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA'
const read = 'R'.repeat(43)
const admission = 'A'.repeat(43)

async function request(token: string, path = '/ws', secrets = { HOST_TOKEN_SECRET: SECRET }) {
  const id = await roomIdFor(token)
  return app.fetch(
    new Request(`https://pedit.test/api/rooms/${id}${path}`, {
      method: path.endsWith('/close') ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Upgrade: path === '/ws' ? 'websocket' : '',
        'Sec-WebSocket-Protocol': admissionProtocols(admission).join(', '),
        [READ_ADMISSION_HEADER]: read,
        'X-Pedit-Keep': '60',
        'X-Pedit-Issued': String(Date.now()),
      },
    }),
    { ...env, ...secrets },
    createExecutionContext(),
  )
}

const held = async (token: string) =>
  runInDurableObject(env.ROOM.get(env.ROOM.idFromName(await roomIdFor(token))), async (_, st) => ({
    keys: [...st.storage.kv.list()].map(([key]) => key),
    alarm: await st.storage.getAlarm(),
  }))

async function closeHost(socket: WebSocket): Promise<void> {
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener('close', resolve))
  socket.close(4008, 'bye')
  await closed
}

const changed = (token: string, index: number) =>
  token.slice(0, index) + (token[index] === 'A' ? 'B' : 'A') + token.slice(index + 1)

describe('signed host issuance (#528)', () => {
  it('authenticates time, nonce, MAC and canonical encoding before reaching a room', async () => {
    const token = await newHostToken(SECRET)
    expect(token).toHaveLength(55)
    for (const forged of [changed(token, 4), changed(token, 15), changed(token, 45)]) {
      expect((await request(forged)).status).toBe(403)
      expect(await held(forged)).toEqual({ keys: [], alarm: null })
      const stub = env.ROOM.get(env.ROOM.idFromName(await roomIdFor(forged)))
      await runInDurableObject(stub, (_, st) => st.storage.kv.put('openedAt', Date.now()))
      expect((await request(forged)).status).toBe(403)
    }
    // The final character has two unused bits; an alias would name a different room.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const last = alphabet.indexOf(token.at(-1)!)
    const alias = token.slice(0, -1) + alphabet[last + 1]
    expect(await verifyHostToken(alias, { HOST_TOKEN_SECRET: SECRET })).toBeUndefined()
    expect((await request(alias)).status).toBe(403)
    expect((await request('pe2_' + 'A'.repeat(39))).status).toBe(403)
  })

  it('checks signatures on WebSockets and every host keep endpoint', async () => {
    const token = await newHostToken(PREVIOUS)
    for (const path of ['/ws', '/keep', '/keep/close']) {
      expect((await request(token, path)).status).toBe(403)
    }
    const id = await roomIdFor(token)
    const response = await app.fetch(
      new Request(`https://pedit.test/api/rooms/${id}/keep`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'X-Pedit-Keep': '60' },
      }),
      { ...env, HOST_TOKEN_SECRET: SECRET },
      createExecutionContext(),
    )
    expect(response.status).toBe(403)
    expect(await held(token)).toEqual({ keys: [], alarm: null })
  })

  it('fails closed for missing or malformed signing configuration', async () => {
    for (const HOST_TOKEN_SECRET of [undefined, '', 'invalid']) {
      const response = await app.fetch(
        new Request('https://pedit.test/api/rooms', { method: 'POST' }),
        { ...env, HOST_TOKEN_SECRET },
        createExecutionContext(),
      )
      expect(response.status).toBe(503)
      const signed = await newHostToken(SECRET)
      expect(await verifyHostToken(signed, { HOST_TOKEN_SECRET })).toBeUndefined()
    }
  })

  it('uses the current key for issuance and accepts the previous key only for verification', async () => {
    const secrets = { HOST_TOKEN_SECRET: SECRET, HOST_TOKEN_PREVIOUS_SECRET: PREVIOUS }
    const response = await app.fetch(
      new Request('https://pedit.test/api/rooms', { method: 'POST' }),
      { ...env, ...secrets },
      createExecutionContext(),
    )
    expect(response.status).toBe(201)
    const { hostToken } = await response.json<{ hostToken: string }>()
    expect((await verifyHostToken(hostToken, { HOST_TOKEN_SECRET: SECRET }))?.kind).toBe('signed')
    expect(await verifyHostToken(hostToken, { HOST_TOKEN_SECRET: PREVIOUS })).toBeUndefined()
    const old = await newHostToken(PREVIOUS)
    const opened = await request(old, '/ws', secrets)
    expect(opened.status).toBe(101)
    opened.webSocket!.accept()
    expect((await request(old, '/keep', secrets)).status).toBe(200)
    expect((await request(old, '/keep')).status).toBe(403)
    await closeHost(opened.webSocket!)
  })

  it('lets an old signed token reconnect to an existing room', async () => {
    const token = await newHostToken(SECRET, Date.now() - OPEN_WINDOW_MS - 60_000)
    const stub = env.ROOM.get(env.ROOM.idFromName(await roomIdFor(token)))
    await runInDurableObject(stub, (_, st) => {
      st.storage.kv.put('openedAt', Date.now() - 60_000)
      st.storage.kv.put('tokenIssuedAt', Date.now() - OPEN_WINDOW_MS - 60_000)
    })
    const opened = await request(token)
    expect(opened.status).toBe(101)
    opened.webSocket!.accept()
    await closeHost(opened.webSocket!)
  })

  it('lets legacy hosts reconnect to opened rooms but never open new ones', async () => {
    const bytes = new Uint8Array(29)
    crypto.getRandomValues(bytes)
    let now = Date.now()
    for (let i = 5; i >= 0; i--) {
      bytes[i] = now % 256
      now = Math.floor(now / 256)
    }
    const tokens = [
      'pe1_' + base64url(bytes),
      base64url(crypto.getRandomValues(new Uint8Array(32))),
    ]
    for (const token of tokens) {
      expect((await request(token)).status).toBe(403)
      expect((await request(token, '/keep')).status).toBe(410)
      expect(await held(token)).toEqual({ keys: [], alarm: null })
      // State created by the pre-upgrade relay, including its original token issue time.
      const stub = env.ROOM.get(env.ROOM.idFromName(await roomIdFor(token)))
      await runInDurableObject(stub, (_, st) => {
        st.storage.kv.put('openedAt', Date.now())
        st.storage.kv.put('tokenIssuedAt', Date.now())
        st.storage.kv.put('keepSeconds', 60)
      })
      const opened = await request(token)
      expect(opened.status).toBe(101)
      opened.webSocket!.accept()
      expect((await request(token, '/keep')).status).toBe(200)
      await closeHost(opened.webSocket!)
    }
  })
})
