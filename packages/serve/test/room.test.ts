import { upgradeWebSocket } from '@hono/node-server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type PeditEvent, peditRoutes } from '../src/hono.ts'
import { type RoomState, ServedFiles, type ServeEvent } from '../src/index.ts'
import { BIN, FAKE, fakePedit, tmpRoot, write } from './helpers.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function script(mode = '') {
  return `
const fs = require('fs')
const mode = ${JSON.stringify(mode)}
const send = o => {
 const b = Buffer.from(JSON.stringify(o)), h = Buffer.alloc(9)
 h[0] = 4; h.writeUInt32BE(b.length, 5); process.stdout.write(Buffer.concat([h,b]))
}
const metadata = {room:'r1',relay:'https://relay.example/prefix',links:{edit:'r1.e',read:'r1.r'},keep:3600,ends:200,lifeEnd:300}
let room = mode === 'away' ? {...metadata,host:'away'} : null
let buf = Buffer.alloc(0), reads = 0
send({event:'listening',generation:'g',serve:2})
process.stdin.on('data', d => {
 buf = Buffer.concat([buf,d])
 while (buf.length >= 9 && buf.length >= 9+buf.readUInt32BE(5)) {
  const n = buf.readUInt32BE(5), kind = buf[0], payload = buf.subarray(9,9+n)
  buf = buf.subarray(9+n)
  if (kind !== 5) continue
  const c = JSON.parse(payload), reply = o => send({...o,id:c.id})
  if (c.cmd === 'share') {
   if (c.relay === 'error') { reply({event:'error',message:'refused'}); continue }
   room = {...metadata,host:'here',keep:c.keep === '0' ? 0 : 3600}
   send({event:'peers',peers:[{name:'Ada',access:'edit',local:true},{name:'Ada',access:'read'}],more:2})
   reply({event:'shared',...room,keptUntil:200,resumed:false,...(mode === 'unknown' ? {keep:null,ends:null,lifeEnd:null} : {}),...(mode === 'old' ? {relay:undefined} : {})})
   if (mode === 'isolation') send({event:'peers',peers:[{name:'Ada',access:'edit',local:true},{name:'Ada',access:'read'}],more:2})
  } else if (c.cmd === 'status' || c.cmd === 'keep') {
   if (c.cmd === 'keep' && room) room.keep = 5400
   if (mode === 'status-error') { reply({event:'error',message:'relay down'}); continue }
   reply({event:'status',...(mode === 'old' ? {} : {roomState:1}),...(room ?? {room:null}),...(mode === 'old' ? {relay:undefined} : {})})
  } else if (c.cmd === 'unshare') {
   room = room?.keep ? {...room,host:'away'} : null
   reply({event:'unshared'})
   send({event:'peers',peers:[{name:'late',access:'edit'}]})
   send({event:'comments',threads:[]})
  } else if (c.cmd === 'close') {
   if (room?.host === 'here') send({event:'unshared'})
   if (mode === 'close-error') {
    room = {...room,host:'away'}
    reply({event:'error',message:'relay busy'})
   } else {
    room = null
    reply({event:'room_ended',reason:'closed'})
   }
  } else if (c.cmd === 'comments') {
   reads++
   if (mode === 'crash') { process.exit(1); continue }
   if (mode.startsWith('race') && reads === 1) {
    send({event:'unshared'})
    room = null
    if (mode === 'race-reshare') send({event:'shared',...metadata,keptUntil:200,resumed:true})
    reply({event:'comments_page',seq:0,done:true,parts:[]})
   } else reply({event:'comments_page',seq:0,done:true,parts:[]})
  }
 }
})
process.stdin.on('end', () => process.exit(0))
`
}

function fixture(mode = '', idleMs = 60000, onEvent?: (e: ServeEvent) => void) {
  const { dir, cleanup } = tmpRoot()
  const events: ServeEvent[] = []
  const bin = fakePedit(dir, 'fake', script(mode))
  const files = new ServedFiles({
    bin,
    app: 'room-test',
    idleMs,
    onEvent: (e) => {
      events.push(e)
      onEvent?.(e)
    },
  })
  cleanups.push(cleanup, () => files.close())
  const states = () => events.filter((e) => e.type === 'room').map((e) => e.state)
  return { dir, files, events, states, bin }
}

function last(states: () => RoomState[]) {
  return states().at(-1)
}

describe.skipIf(!FAKE)('whole room state', () => {
  it('publishes serving before hydration and deduplicates authoritative absence', async () => {
    const f = fixture()
    const file = await f.files.acquire(write(f.dir, 'a.md'))
    expect(last(f.states)).toMatchObject({
      serving: true,
      known: false,
      room: null,
      comments: 'saved',
      ended: null,
    })
    expect(await file.room()).toEqual({
      serving: true,
      known: true,
      room: null,
      comments: 'saved',
      ended: null,
    })
    await file.status()
    await file.room()
    expect(f.states()).toHaveLength(2)
  })

  it('merges startup local peers and canonical status without losing resumed or invalidating reads', async () => {
    const f = fixture()
    const file = await f.files.acquire(write(f.dir, 'a.md'))
    expect(await file.share()).toMatchObject({ relay: 'https://relay.example/prefix' })
    expect(last(f.states)).toMatchObject({
      comments: 'live',
      room: {
        keep: '1h',
        resumed: false,
        more: 2,
        peers: [
          { name: 'Ada', access: 'edit', local: true },
          { name: 'Ada', access: 'read' },
        ],
      },
    })
    const count = f.states().length
    await file.room()
    await file.room()
    expect(f.states()).toHaveLength(count)
    expect(await file.keep('1h30m')).toMatchObject({ keep: '90m' })
    expect(last(f.states)?.room?.keep).toBe('90m')
  })

  it('preserves a kept-away room after failed close, clears live data, and ignores late events', async () => {
    const f = fixture('close-error')
    const file = await f.files.acquire(write(f.dir, 'a.md'))
    await file.share()
    await expect(file.close()).rejects.toThrow('relay busy')
    expect(last(f.states)).toMatchObject({
      comments: 'saved',
      room: { host: 'away', keep: '1h', peers: [], more: 0, freshness: 'stale' },
    })
    expect(await file.comments()).toEqual([])
    await file.unshare()
    expect(last(f.states)?.room?.peers).toEqual([])
    expect(f.events.filter((e) => e.type === 'comments')).toHaveLength(0)
    expect(f.events.filter((e) => e.type === 'peers')).toHaveLength(1)
  })

  it('closes an away room in one call and reports why it ended', async () => {
    const f = fixture('away')
    const file = await f.files.acquire(write(f.dir, 'a.md'))
    expect((await file.room()).room).toMatchObject({ host: 'away', resumed: null })
    await file.close()
    expect(last(f.states)).toMatchObject({ room: null, comments: 'saved', ended: 'closed' })
    await file.room()
    expect(last(f.states)?.ended).toBe('closed')
    await file.share()
    expect(last(f.states)?.ended).toBeNull()
  })

  it('ends a live room on departure and permits callback reentrancy after correlation settles', async () => {
    let file: Awaited<ReturnType<ServedFiles['acquire']>> | undefined
    let again: Promise<unknown> | undefined
    const f = fixture('', 60000, (e) => {
      if (e.type === 'room' && e.state.ended === 'closed' && !again) again = file?.share()
    })
    file = await f.files.acquire(write(f.dir, 'a.md'))
    await file.share({ keep: '0' })
    await file.unshare()
    expect(last(f.states)).toMatchObject({ room: null, comments: 'saved', ended: 'left' })
    await file.share()
    await file.close()
    await expect(again).resolves.toMatchObject({ type: 'shared' })
    expect(last(f.states)).toMatchObject({ comments: 'live', ended: null })
  })

  it('keeps successful sharing compatible with old binaries and unknown metadata', async () => {
    for (const mode of ['old', 'unknown', 'status-error']) {
      const f = fixture(mode)
      const file = await f.files.acquire(write(f.dir, 'a.md'))
      await expect(file.share()).resolves.toMatchObject({ type: 'shared' })
      if (mode === 'unknown') {
        expect(last(f.states)?.room).toMatchObject({ keep: null, ends: null, lifeEnd: null })
        expect((await file.room()).room).toMatchObject({ keep: '1h', ends: 200, lifeEnd: 300 })
      } else {
        await expect(file.room()).rejects.toThrow(mode === 'old' ? /too old.*update/ : /relay down/)
      }
      await expect(file.unshare()).resolves.toBeUndefined()
    }
  })

  it('retains stale metadata on crash, rejects live reads, and hydrates a restarted child', async () => {
    const f = fixture('crash')
    const path = write(f.dir, 'a.md')
    const file = await f.files.acquire(path)
    await file.share()
    await expect(file.comments()).rejects.toThrow('no longer served')
    await vi.waitFor(() =>
      expect(last(f.states)).toMatchObject({
        serving: false,
        comments: 'saved',
        room: { relay: 'https://relay.example/prefix', peers: [], more: 0, freshness: 'stale' },
      }),
    )
    const next = await f.files.acquire(path)
    expect(last(f.states)).toMatchObject({
      serving: true,
      known: false,
      room: { freshness: 'stale' },
    })
    expect((await next.room()).room).toBeNull()
  })

  it.each(['race', 'race-reshare'])(
    'rejects comments crossing departure or re-share (%s)',
    async (mode) => {
      const f = fixture(mode)
      const file = await f.files.acquire(write(f.dir, 'a.md'))
      await file.share()
      await expect(file.comments()).rejects.toThrow('room changed while reading comments')
      expect(await file.comments()).toEqual([])
      expect(last(f.states)?.comments).toBe(mode === 'race' ? 'saved' : 'live')
    },
  )

  it('does not pin a kept-away child and hydrates after idle restart', async () => {
    const f = fixture('away', 30)
    const path = write(f.dir, 'a.md')
    const file = await f.files.acquire(path)
    await file.room()
    await vi.waitFor(() => expect(last(f.states)?.serving).toBe(false))
    const next = await f.files.acquire(path)
    expect((await next.room()).room).toMatchObject({ host: 'away', freshness: 'current' })
  })

  it('does not expose mutable internal snapshots to callbacks or callers', async () => {
    const f = fixture('isolation', 60000, (e) => {
      if (e.type === 'room' && e.state.room) e.state.room.links.edit = 'mutated'
      if (e.type === 'shared') e.links.edit = 'mutated'
      if (e.type === 'peers' && e.peers[0]) e.peers[0].name = 'mutated'
    })
    const file = await f.files.acquire(write(f.dir, 'a.md'))
    await file.share()
    await vi.waitFor(() => expect(f.events.filter((e) => e.type === 'peers')).toHaveLength(2))
    expect(f.states()).toHaveLength(2)
    const state = await file.room()
    expect(state.room?.peers.map((peer) => peer.name)).toEqual(['Ada', 'Ada'])
    expect(state.room?.links.edit).toBe('r1.e')
    if (state.room) state.room.links.edit = 'mutated'
    expect((await file.room()).room?.links.edit).toBe('r1.e')
  })
})

describe.skipIf(!BIN)('room state with real pedit', () => {
  it('publishes path state before any page id and stops the unshared child on idle', async () => {
    const { dir, cleanup } = tmpRoot()
    const path = write(dir, 'a.md')
    const events: PeditEvent[] = []
    const routes = peditRoutes({
      root: dir,
      bin: BIN,
      app: 'room-test',
      origins: ['http://localhost'],
      idleMs: 50,
      upgradeWebSocket,
      resolve: async () => null,
      onEvent: (e) => events.push(e),
    })
    cleanups.push(cleanup, () => routes.close())
    expect(await routes.room(path)).toEqual({
      serving: true,
      known: true,
      room: null,
      comments: 'saved',
      ended: null,
    })
    await routes.status(path)
    await vi.waitFor(() =>
      expect(events.filter((e) => e.type === 'room').at(-1)).toMatchObject({
        path,
        id: null,
        state: { serving: false, room: null },
      }),
    )
    expect(events.filter((e) => e.type === 'room')).toHaveLength(3)
    expect(events.filter((e) => e.type === 'room')[0]).toMatchObject({
      path,
      id: null,
      state: { serving: true, known: false },
    })
    expect((await routes.room(path)).known).toBe(true)
  })
})
