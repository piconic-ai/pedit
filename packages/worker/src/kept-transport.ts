import { DurableLog, type LogCut, type LogLimits } from './durable-log.ts'
import { KeptAdmission, type KeptCapabilities } from './kept-admission.ts'
import { type KeepPolicy, KeptLifecycle } from './kept-lifecycle.ts'

export class KeptTransport {
  private readonly admission: KeptAdmission
  private readonly lifecycle: KeptLifecycle

  constructor(
    private readonly state: DurableObjectState,
    namespace: Pick<Env['ROOM'], 'idFromName'>,
    private readonly limits: LogLimits,
    policy: KeepPolicy,
    now: () => number = Date.now,
    maintenanceClosed: () => boolean = () => false,
  ) {
    this.admission = new KeptAdmission(state, namespace)
    this.lifecycle = new KeptLifecycle(state, namespace, policy, now, maintenanceClosed)
  }

  private log(): DurableLog {
    return new DurableLog(this.state.storage, this.limits, () => this.lifecycle.assertOpen())
  }

  private async active(): Promise<void> {
    await this.lifecycle.observe()
    this.lifecycle.assertOpen()
  }

  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      await this.active()
      const result = await action()
      await this.active()
      return result
    } catch (error) {
      await this.lifecycle.rememberObservation()
      throw error
    }
  }

  async initialize(
    roomId: string,
    hostToken: string,
    capabilities: KeptCapabilities,
    epoch: string,
    ciphertext: ArrayBuffer,
  ): Promise<void> {
    const input = ciphertext.slice(0)
    await this.admission.register(roomId, hostToken, capabilities)
    await this.lifecycle.start(roomId, hostToken)
    await this.run(() => this.log().initialize(epoch, input))
  }

  async append(token: string, epoch: string, ciphertext: ArrayBuffer): Promise<number> {
    const input = ciphertext.slice(0)
    if (!(await this.admission.canAppend(token))) throw new Error('append admission denied')
    return this.run(() => this.log().append(epoch, input))
  }

  private async allowRead(token: string) {
    const role = await this.admission.role(token)
    if (!role) throw new Error('read admission denied')
    return role
  }

  async beginRead(token: string) {
    const role = await this.allowRead(token)
    return this.run(() => this.log().beginRead(role))
  }

  async beginHostRead(roomId: string, hostToken: string) {
    await this.admission.authorizeHost(roomId, hostToken)
    return this.run(() => this.log().beginRead('host'))
  }

  async readHostPage(roomId: string, hostToken: string, session: string, cursor: string) {
    await this.admission.authorizeHost(roomId, hostToken)
    return this.run(() => this.log().readPage(session, cursor, 'host'))
  }

  async finishHostRead(roomId: string, hostToken: string, session: string, cursor: string) {
    await this.admission.authorizeHost(roomId, hostToken)
    await this.run(() => this.log().finishRead(session, cursor, 'host'))
  }

  async readPage(token: string, session: string, cursor: string) {
    const role = await this.allowRead(token)
    return this.run(() => this.log().readPage(session, cursor, role))
  }

  async finishRead(token: string, session: string, cursor: string): Promise<void> {
    const role = await this.allowRead(token)
    await this.run(() => this.log().finishRead(session, cursor, role))
  }

  async freeze(
    roomId: string,
    hostToken: string,
    epoch: string,
    generation: number,
  ): Promise<LogCut> {
    await this.admission.authorizeHost(roomId, hostToken)
    return this.run(() => this.log().freeze(epoch, generation))
  }

  async pendingCut(roomId: string, hostToken: string): Promise<LogCut | undefined> {
    await this.admission.authorizeHost(roomId, hostToken)
    return this.run(async () => this.log().pendingCut())
  }

  async commit(
    roomId: string,
    hostToken: string,
    cut: LogCut,
    epoch: string,
    ciphertext: ArrayBuffer,
  ): Promise<void> {
    const expectedCut = { ...cut }
    const input = ciphertext.slice(0)
    await this.admission.authorizeHost(roomId, hostToken)
    await this.run(() => this.log().commit(expectedCut, epoch, input))
  }

  async abort(roomId: string, hostToken: string, cut: LogCut): Promise<void> {
    const expectedCut = { ...cut }
    await this.admission.authorizeHost(roomId, hostToken)
    await this.run(() => this.log().abort(expectedCut))
  }
  async status(roomId: string, hostToken: string) {
    await this.admission.authorizeHost(roomId, hostToken)
    return this.lifecycle.observe()
  }

  async leave(roomId: string, hostToken: string) {
    return this.lifecycle.leave(roomId, hostToken)
  }

  async resume(roomId: string, hostToken: string) {
    return this.lifecycle.resume(roomId, hostToken)
  }

  async close(roomId: string, hostToken: string) {
    return this.lifecycle.close(roomId, hostToken)
  }

  async alarm() {
    return this.lifecycle.observe()
  }
}
