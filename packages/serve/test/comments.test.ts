import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { CommentsRead } from '../src/comments.ts'
import { peditRoutes } from '../src/hono.ts'
import { type CommentThread, ServedFiles, type ServeEvent } from '../src/index.ts'
import { BIN, FAKE, fakePedit, tmpRoot, write } from './helpers.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const header: Omit<CommentThread, 'messages' | 'cut'> = {
  id: 't1',
  quote: 'wide',
  resolved: false,
  from: 3,
  to: 7,
}
const m1 = { id: 'm1', author: 'Ada', time: '2026-11-01T00:00:00Z', body: 'First' }
const m2 = { ...m1, id: 'm2', body: 'Second' }
const part = (offset = 0, messages = [m1], total = 2) => ({
  thread: header,
  offset,
  total,
  messages,
})
const page = (seq: number, done: boolean, parts = [part()]) => ({
  event: 'comments_page',
  seq,
  done,
  parts,
})

function script(answer: string, serve = 2) {
  return `
const send = (o) => {
 const b = Buffer.from(JSON.stringify(o)), h = Buffer.alloc(9)
 h[0] = 4; h.writeUInt32BE(b.length,5); process.stdout.write(Buffer.concat([h,b]))
}
send({event:'listening',generation:'g',serve:${serve}})
const header = ${JSON.stringify(header)}, m1 = ${JSON.stringify(m1)}, m2 = ${JSON.stringify(m2)}
let buf = Buffer.alloc(0)
process.stdin.on('data', d => {
 buf = Buffer.concat([buf,d])
 while (buf.length >= 9 && buf.length >= 9+buf.readUInt32BE(5)) {
  const n = buf.readUInt32BE(5), kind = buf[0], payload = buf.subarray(9,9+n)
  buf = buf.subarray(9+n)
  if (kind !== 5) continue
  const c = JSON.parse(payload)
  const reply = (o) => send({...o,id:c.id})
  ${answer}
 }
})
process.stdin.on('end', () => process.exit(0))
`
}

function fake(answer: string, serve = 2) {
  const { dir, cleanup } = tmpRoot()
  const events: ServeEvent[] = []
  const files = new ServedFiles({
    bin: fakePedit(dir, 'fake', script(answer, serve)),
    app: 'comments-test',
    onEvent: (e) => events.push(e),
  })
  cleanups.push(cleanup, () => files.close())
  return { dir, files, events }
}

it('assembles complete ordered threads, including empty and detached threads', () => {
  const read = new CommentsRead()
  expect(read.accept(page(0, false))).toBe(false)
  expect(
    read.accept(
      page(1, true, [
        part(1, [m2]),
        {
          thread: { ...header, id: 'empty', from: null, to: null },
          offset: 0,
          total: 0,
          messages: [],
        },
      ]),
    ),
  ).toBe(true)
  expect(read.threads).toEqual([
    { ...header, messages: [m1, m2] },
    { ...header, id: 'empty', from: null, to: null, messages: [] },
  ])
})

it.each([
  ['sequence', page(1, true)],
  ['final incomplete thread', page(0, true)],
  ['offset', page(0, true, [part(1, [m1])])],
  ['message count', page(0, true, [part(0, [m1], 0)])],
  ['duplicate thread', page(0, true, [part(0, [m1], 1), part(0, [m1], 1)])],
  ['empty progress', page(0, false, [])],
  ['invalid thread', { ...page(0, true), parts: [{ ...part(), thread: null }] }],
])('rejects %s instead of returning partial comments', (_, invalid) => {
  expect(() => new CommentsRead().accept(invalid)).toThrow()
})

it('rejects a changed header or skipped messages between pages', () => {
  for (const next of [
    part(2, [m2], 3),
    { ...part(1, [m2]), thread: { ...header, resolved: true } },
  ]) {
    const read = new CommentsRead()
    read.accept(page(0, false))
    expect(() => read.accept(page(1, true, [next]))).toThrow()
  }
})

describe.skipIf(!FAKE)('comments command', () => {
  it('correlates concurrent streams and keeps pages out of live callbacks', async () => {
    const { dir, files, events } = fake(`
     reply({event:'comments_page',seq:0,done:false,parts:[{thread:header,offset:0,total:2,messages:[m1]}]})
     send({event:'comments',threads:[{...header,messages:[m2]}],more:1})
     setTimeout(() => reply({event:'comments_page',seq:1,done:true,parts:[{thread:header,offset:1,total:2,messages:[m2]}]}),20)
    `)
    const served = await files.acquire(write(dir, 'a.md'))
    const results = await Promise.all([served.comments(), served.comments()])
    expect(results).toEqual([
      [{ ...header, messages: [m1, m2] }],
      [{ ...header, messages: [m1, m2] }],
    ])
    expect(events.filter((e) => e.type === 'comments')).toEqual(
      Array.from({ length: 2 }, () => ({
        type: 'comments',
        path: served.path,
        threads: [{ ...header, messages: [m2] }],
        more: 1,
      })),
    )
  })

  it('rejects a malformed stream and a child that exits before its last page', async () => {
    for (const answer of [
      `reply({event:'comments_page',seq:1,done:true,parts:[]})`,
      `reply({event:'comments_page',seq:0,done:false,parts:[{thread:header,offset:0,total:2,messages:[m1]}]}); process.exit(0)`,
      `reply({event:'error',cmd:'comments',message:'cannot read metadata'})`,
    ]) {
      const { dir, files } = fake(answer)
      const served = await files.acquire(write(dir, 'a.md'))
      await expect(served.comments()).rejects.toThrow()
    }
  })

  it('tells an old pedit to update', async () => {
    const { dir, files } = fake(`reply({event:'error',cmd:'',message:'unknown cmd'})`)
    const served = await files.acquire(write(dir, 'a.md'))
    await expect(served.comments()).rejects.toThrow('pedit is too old for comments; update it')
  })
})

describe.skipIf(!BIN)('saved comments through the real binary', () => {
  it('returns every saved message without sharing or changing metadata', async () => {
    const { dir, cleanup } = tmpRoot()
    mkdirSync(join(dir, '.pedit', 'meta'), { recursive: true })
    writeFileSync(join(dir, '.pedit', 'config.yaml'), 'server: https://edit.piconic.ai\n', {
      mode: 0o600,
    })
    const file = write(dir, 'a.md', '😀\r\nhello wide world\r\n')
    const messages = Object.fromEntries(
      Array.from({ length: 190 }, (_, i) => [
        `m${String(i).padStart(3, '0')}`,
        { author: 'Ada', time: '2026-11-01T00:00:00Z', body: `${i}: ${'x'.repeat(3000)}` },
      ]),
    )
    const saved = JSON.stringify({
      version: 1,
      path: 'a.md',
      comments: {
        t1: {
          anchor: { type: 'text', exact: 'wide', prefix: 'hello ', suffix: ' world', offset: 9 },
          quote: 'wide',
          resolved: false,
          messages,
        },
      },
    })
    const meta = join(dir, '.pedit', 'meta', 'a.md.json')
    writeFileSync(meta, saved, { mode: 0o600 })
    const events: ServeEvent[] = []
    const files = new ServedFiles({
      bin: BIN as string,
      app: 'comments-test',
      onEvent: (e) => events.push(e),
    })
    cleanups.push(cleanup, () => files.close())
    const served = await files.acquire(file)
    const result = await served.comments()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 't1', from: 9, to: 13, quote: 'wide', resolved: false })
    expect(result[0]?.messages).toEqual(
      Object.entries(messages).map(([id, message]) => ({ id, ...message })),
    )
    expect(readFileSync(meta, 'utf8')).toBe(saved)
    expect(events.some((e) => e.type === 'shared' || e.type === 'comments')).toBe(false)
    writeFileSync(meta, '{"version":99}', { mode: 0o600 })
    await expect(served.comments()).rejects.toThrow('newer pedit')
  })

  it('routes apply the same path confinement and read unshared files', async () => {
    const { dir, cleanup } = tmpRoot()
    const root = join(dir, 'root')
    mkdirSync(root)
    const file = write(root, 'a.md')
    const { upgradeWebSocket } = createNodeWebSocket({ app: new Hono() })
    const routes = peditRoutes({
      root,
      app: 'comments-test',
      bin: BIN,
      origins: ['http://localhost'],
      upgradeWebSocket,
      resolve: async () => null,
    })
    cleanups.push(cleanup, () => routes.close())
    expect(await routes.comments(file)).toEqual([])
    await expect(routes.comments(write(dir, 'outside.md'))).rejects.toThrow()
    if (process.platform !== 'win32') {
      symlinkSync(join(dir, 'outside.md'), join(root, 'link.md'))
      await expect(routes.comments(join(root, 'link.md'))).rejects.toThrow()
    }
  })
})
