import { expect, it } from 'vitest'
import { keptReadSessionForCleanup } from '../src/kept-read-wire.ts'

it('extracts only canonical, well-formed session capabilities', () => {
  const id = '01234567-89ab-4cde-8abc-0123456789ab'
  expect(keptReadSessionForCleanup(JSON.stringify({ epoch: 'invalid', session: id }))).toBe(id)
  for (const raw of [
    JSON.stringify({ session: 'bad' }),
    JSON.stringify({ session: '01234567-89ab-1cde-8abc-0123456789ab' }),
    JSON.stringify({ session: id.toUpperCase() }),
    `{"session":"${id}","session":"${id}"}`,
    ` {"session":"${id}"}`,
    `{"session":"${id}`,
    JSON.stringify([id]),
    JSON.stringify({ session: 3 }),
  ])
    expect(keptReadSessionForCleanup(raw)).toBeUndefined()
})
