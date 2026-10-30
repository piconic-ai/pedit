import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { admissionProtocols } from '@pedit/protocol/admission'
import { describe, expect, it } from 'vitest'

// A room kept over HTTP (the removed polling mode) may still sit in a Durable
// Object after the deploy. It is torn down and answers as a room that ended.
async function legacyRoom() {
  const name = crypto.randomUUID().replace(/-/g, '')
  const room = env.ROOM.get(env.ROOM.idFromName(name))
  let prefix = ''
  await runInDurableObject(room, async (_, state) => {
    prefix = `kept/${state.id.toString()}/`
    state.storage.sql.exec(
      'CREATE TABLE kept_text_log (id INTEGER PRIMARY KEY, body BLOB NOT NULL, sender TEXT NOT NULL)',
    )
    state.storage.sql.exec("INSERT INTO kept_text_log VALUES (1, x'01', 'a')")
    state.storage.kv.put('keptText', { until: Date.now() + 100000, total: null })
    await state.storage.setAlarm(Date.now() + 100000)
  })
  await env.BLOBS.put(`${prefix}1`, new Uint8Array(4))
  return { name, room, prefix }
}

async function expectTornDown(room: DurableObjectStub, prefix: string) {
  await runInDurableObject(room, (_, state) => {
    expect(state.storage.kv.get('keptText')).toBeUndefined()
    expect(state.storage.kv.get('keptTextClosed')).toBe(true)
    expect(
      state.storage.sql
        .exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'kept_text_log'")
        .one().n,
    ).toBe(0)
  })
  expect((await env.BLOBS.list({ prefix })).objects).toHaveLength(0)
}

describe('a room kept over HTTP before that mode was removed', () => {
  it('is torn down on the next request, which says the room ended', async () => {
    const { name, room, prefix } = await legacyRoom()
    const res = await room.fetch(`https://room/api/rooms/${name}/blobs/x`)
    expect(res.status).toBe(410)
    await expectTornDown(room, prefix)
    expect((await room.fetch(`https://room/api/rooms/${name}/blobs/x`)).status).toBe(410)
  })

  it('is torn down at its alarm', async () => {
    const { room, prefix } = await legacyRoom()
    expect(await runDurableObjectAlarm(room)).toBe(true)
    await expectTornDown(room, prefix)
  })
})

it('closes a guest that connects with the code of a room that expired', async () => {
  const { name, room, prefix } = await legacyRoom()
  const res = await room.fetch(`https://room/api/rooms/${name}/ws`, {
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': admissionProtocols('A'.repeat(43)).join(', '),
    },
  })
  expect(res.status).toBe(101)
  const ws = res.webSocket
  if (!ws) throw new Error('no socket')
  ws.accept()
  const closed = await new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve))
  expect(closed.code).toBe(4007)
  await expectTornDown(room, prefix)
})

describe('/keep/ on the relay', () => {
  it('answers 404 to any action but close', async () => {
    const id = 'a'.repeat(22)
    for (const action of ['init', 'append', 'checkpoint', 'away', 'connect']) {
      const res = await exports.default.fetch(`https://pedit.test/api/rooms/${id}/keep/${action}`, {
        method: 'POST',
      })
      expect(res.status, action).toBe(404)
    }
  })
})
