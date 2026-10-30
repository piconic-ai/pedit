import { describe, expect, it } from 'vitest'
import {
  admissionProtocols,
  checkProtocolVersion,
  deriveAdmissionToken,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  readAdmissionProtocol,
  SOCKET_PROTOCOL,
} from '../src/admission.ts'
import { deriveBlobKeys } from '../src/blob.ts'
import { fromBase64Url } from '../src/key.ts'

describe('room admission', () => {
  it('matches the independently computed Go test vector and separates the capability from the key', async () => {
    const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
    const token = await deriveAdmissionToken(fromBase64Url(key))
    expect(token).toBe('G8eCuavz2F_pjyWhj9ozn44ZXf9ZGxvqFKL8L52-udA')
    expect(token).not.toBe(key)
    expect((await deriveBlobKeys(fromBase64Url(key))).admission).toBe(token)
    expect(readAdmissionProtocol(admissionProtocols(token).join(', '))).toBe(token)
  })

  it('rejects missing, malformed and ambiguous subprotocol credentials', () => {
    const token = 'A'.repeat(43)
    for (const value of [
      null,
      '',
      'pedit-v1',
      `pedit-admission.${token}`,
      'pedit-v1, pedit-admission.bad',
      `pedit-v1, pedit-admission.${token}, pedit-admission.${token}`,
    ]) {
      expect(readAdmissionProtocol(value)).toBeNull()
    }
    expect(() => admissionProtocols('bad')).toThrow()
    expect(admissionProtocols(token, 5)[0]).toBe('pedit-v5')
    expect(readAdmissionProtocol(admissionProtocols(token, 5).join(', '))).toBe(token)
    expect(readAdmissionProtocol(`pedit-v7, pedit-admission.${token}`)).toBeNull()
  })

  it('compares the offered protocol versions with its own', () => {
    // Version 2 numbered frames against replays (frame.ts). Version 3: a
    // command line guest names its copies itself, so older ones, which take
    // the names a room gives, are turned away. Version 4: the relay waits for
    // a host that dropped and tells guests so, which older clients would take
    // for a closed room. Version 5: editors sign their frames, and peers
    // apply only what the signer's link allows (#122); older peers would
    // apply anyone's.
    // Version 6: every binary message starts with a kind byte (kinds.ts), so
    // a room can keep a text while its host is away. The relay still serves
    // version 5, which has none.
    expect(PROTOCOL_VERSION).toBe(6)
    expect(SOCKET_PROTOCOL).toBe('pedit-v6')
    expect(MIN_PROTOCOL_VERSION).toBe(5)
    const token = `pedit-admission.${'A'.repeat(43)}`
    expect(checkProtocolVersion(`pedit-v5, ${token}`)).toEqual({ result: 'current', version: 5 })
    expect(checkProtocolVersion(`pedit-v6, ${token}`)).toEqual({ result: 'current', version: 6 })
    expect(checkProtocolVersion('pedit-v5, pedit-v6')).toEqual({ result: 'current', version: 6 })
    expect(checkProtocolVersion('pedit-v7, pedit-v5')).toEqual({ result: 'current', version: 5 })
    expect(checkProtocolVersion(`pedit-v7, ${token}`)).toEqual({
      result: 'server-outdated',
      offered: 'pedit-v7',
    })
    expect(checkProtocolVersion('pedit-v8, pedit-v7')).toEqual({
      result: 'server-outdated',
      offered: 'pedit-v8',
    })
    expect(checkProtocolVersion(`pedit-v4, ${token}`)).toEqual({
      result: 'client-outdated',
      offered: 'pedit-v4',
    })
    for (const value of [null, '', token, 'pedit-v', 'pedit-v01', 'pedit-vx', 'pedit-v1.0']) {
      expect(checkProtocolVersion(value)).toEqual({ result: 'none' })
    }
  })
})
