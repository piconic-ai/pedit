import { describe, expect, it } from 'vitest'
import {
  admissionProtocols,
  checkProtocolVersion,
  deriveAdmissionToken,
  PROTOCOL_VERSION,
  readAdmissionProtocol,
  SOCKET_PROTOCOL,
} from '../src/admission.ts'
import { deriveBlobKeys } from '../src/blob.ts'

describe('room admission', () => {
  it('matches the independently computed Go test vector and separates the capability from the key', async () => {
    const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
    const token = await deriveAdmissionToken(key)
    expect(token).toBe('yLmGLPEIKTlJRTyTeaGzls7vTRq2eymHCb_TJWm55EI')
    expect(token).not.toBe(key)
    expect((await deriveBlobKeys(key)).admission).toBe(token)
    expect(readAdmissionProtocol(admissionProtocols(token).join(', '))).toBe(token)
    await expect(deriveAdmissionToken('bad')).rejects.toThrow()
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
  })

  it('compares the offered protocol versions with its own', () => {
    // Version 2 numbered frames against replays (frame.ts). Version 3: a
    // command line guest names its copies itself, so older ones, which take
    // the names a room gives, are turned away.
    expect(PROTOCOL_VERSION).toBe(3)
    expect(SOCKET_PROTOCOL).toBe('pedit-v3')
    const token = `pedit-admission.${'A'.repeat(43)}`
    expect(checkProtocolVersion(`pedit-v3, ${token}`)).toEqual({ result: 'current' })
    expect(checkProtocolVersion('pedit-v4, pedit-v3')).toEqual({ result: 'current' })
    expect(checkProtocolVersion(`pedit-v4, ${token}`)).toEqual({
      result: 'server-outdated',
      offered: 'pedit-v4',
    })
    expect(checkProtocolVersion('pedit-v5, pedit-v4')).toEqual({
      result: 'server-outdated',
      offered: 'pedit-v5',
    })
    expect(checkProtocolVersion(`pedit-v2, ${token}`)).toEqual({
      result: 'client-outdated',
      offered: 'pedit-v2',
    })
    for (const value of [null, '', token, 'pedit-v', 'pedit-v01', 'pedit-vx', 'pedit-v1.0']) {
      expect(checkProtocolVersion(value)).toEqual({ result: 'none' })
    }
  })
})
