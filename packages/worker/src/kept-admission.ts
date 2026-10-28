import { ADMISSION_PATTERN } from '@pedit/protocol/admission'
import { roomIdFor } from './room-identity.ts'
import { ADMISSION_KEY } from './room-storage.ts'

export const KEPT_ADMISSION_KEY = 'keptAdmission'

export type KeptRole = 'editor' | 'commenter' | 'reader'
type Verifiers = { editor: ArrayBuffer; commenter: ArrayBuffer; reader: ArrayBuffer }
export type KeptCapabilities = { editor: string; commenter: string; reader: string }

async function digest(token: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
}
function equal(a: ArrayBuffer, b: ArrayBuffer): boolean {
  return crypto.subtle.timingSafeEqual(a, b)
}

export class KeptAdmission {
  constructor(
    private readonly state: DurableObjectState,
    private readonly namespace: Pick<Env['ROOM'], 'idFromName'>,
  ) {}

  async register(roomId: string, hostToken: string, capabilities: KeptCapabilities): Promise<void> {
    const { editor, commenter, reader } = capabilities
    if (
      !/^[A-Za-z0-9_-]{22}$/.test(roomId) ||
      !ADMISSION_PATTERN.test(hostToken) ||
      this.namespace.idFromName(roomId).toString() !== this.state.id.toString() ||
      (await roomIdFor(hostToken)) !== roomId
    )
      throw new Error('invalid host credentials')
    if (
      !ADMISSION_PATTERN.test(editor) ||
      !ADMISSION_PATTERN.test(commenter) ||
      !ADMISSION_PATTERN.test(reader) ||
      new Set([editor, commenter, reader]).size !== 3
    )
      throw new Error('invalid kept admission')
    const [e, c, r] = await Promise.all([digest(editor), digest(commenter), digest(reader)])
    const verifiers: Verifiers = { editor: e, commenter: c, reader: r }
    this.state.storage.transactionSync(() => {
      const kv = this.state.storage.kv
      const existing = kv.get<Verifiers>(KEPT_ADMISSION_KEY)
      if (existing) {
        const active = kv.get<ArrayBuffer>(ADMISSION_KEY)
        if (
          !active ||
          !equal(active, e) ||
          !equal(existing.editor, e) ||
          !equal(existing.commenter, c) ||
          !equal(existing.reader, r)
        )
          throw new Error('kept admission already registered')
        return
      }
      if (kv.get(ADMISSION_KEY) !== undefined || kv.get('openedAt') !== undefined)
        throw new Error('room already used')
      kv.put(KEPT_ADMISSION_KEY, verifiers)
      kv.put(ADMISSION_KEY, e)
    })
    await this.state.storage.sync()
    const active = this.state.storage.kv.get<ArrayBuffer>(ADMISSION_KEY)
    const current = this.state.storage.kv.get<Verifiers>(KEPT_ADMISSION_KEY)
    if (
      !active ||
      !current ||
      !equal(active, e) ||
      !equal(current.editor, e) ||
      !equal(current.commenter, c) ||
      !equal(current.reader, r)
    )
      throw new Error('kept admission no longer active')
  }

  async role(token: string): Promise<KeptRole | null> {
    if (!ADMISSION_PATTERN.test(token)) return null
    const candidate = await digest(token)
    const kv = this.state.storage.kv
    const verifiers = kv.get<Verifiers>(KEPT_ADMISSION_KEY)
    const active = kv.get<ArrayBuffer>(ADMISSION_KEY)
    if (!verifiers || !active || !equal(active, verifiers.editor)) return null
    if (equal(candidate, verifiers.editor)) return 'editor'
    if (equal(candidate, verifiers.commenter)) return 'commenter'
    if (equal(candidate, verifiers.reader)) return 'reader'
    return null
  }

  async canAppend(token: string): Promise<boolean> {
    const role = await this.role(token)
    return role === 'editor' || role === 'commenter'
  }
}
