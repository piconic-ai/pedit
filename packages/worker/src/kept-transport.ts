import { DurableLog, type LogCut, type LogLimits } from './durable-log.ts'
import { KeptAdmission, type KeptCapabilities } from './kept-admission.ts'

export class KeptTransport {
  private readonly admission: KeptAdmission

  constructor(
    private readonly state: DurableObjectState,
    namespace: Pick<Env['ROOM'], 'idFromName'>,
    private readonly limits: LogLimits,
  ) {
    this.admission = new KeptAdmission(state, namespace)
  }

  private log(): DurableLog {
    return new DurableLog(this.state.storage, this.limits)
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
    await this.log().initialize(epoch, input)
  }

  async append(token: string, epoch: string, ciphertext: ArrayBuffer): Promise<number> {
    const input = ciphertext.slice(0)
    if (!(await this.admission.canAppend(token))) throw new Error('append admission denied')
    return this.log().append(epoch, input)
  }

  private async allowRead(token: string): Promise<void> {
    if (!(await this.admission.role(token))) throw new Error('read admission denied')
  }

  async beginRead(token: string) {
    await this.allowRead(token)
    return this.log().beginRead()
  }

  async readPage(token: string, session: string, cursor: string) {
    await this.allowRead(token)
    return this.log().readPage(session, cursor)
  }

  async finishRead(token: string, session: string, cursor: string): Promise<void> {
    await this.allowRead(token)
    await this.log().finishRead(session, cursor)
  }

  async freeze(
    roomId: string,
    hostToken: string,
    epoch: string,
    generation: number,
  ): Promise<LogCut> {
    await this.admission.authorizeHost(roomId, hostToken)
    return this.log().freeze(epoch, generation)
  }

  async pendingCut(roomId: string, hostToken: string): Promise<LogCut | undefined> {
    await this.admission.authorizeHost(roomId, hostToken)
    return this.log().pendingCut()
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
    await this.log().commit(expectedCut, epoch, input)
  }

  async abort(roomId: string, hostToken: string, cut: LogCut): Promise<void> {
    const expectedCut = { ...cut }
    await this.admission.authorizeHost(roomId, hostToken)
    await this.log().abort(expectedCut)
  }
}
