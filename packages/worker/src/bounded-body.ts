export class BodyTooLargeError extends Error {}
export class InvalidBodyLengthError extends Error {}
export class BodyReadTimeoutError extends Error {}
export class BodyChunkLimitError extends Error {}

const BODY_READ_TIMEOUT_MS = 30_000
export const MAX_BODY_CHUNKS = 16_384

function declaredLength(request: Request, maximum: number): number | undefined {
  const header = request.headers.get('Content-Length')
  if (header === null) return undefined
  if (!/^(0|[1-9][0-9]*)$/.test(header)) throw new InvalidBodyLengthError('invalid body length')
  const declared = Number(header)
  if (!Number.isSafeInteger(declared)) throw new InvalidBodyLengthError('invalid body length')
  if (declared > maximum) throw new BodyTooLargeError('body too large')
  return declared
}

function readDeclaredLength(request: Request, maximum: number): number | undefined {
  try {
    return declaredLength(request, maximum)
  } catch (error) {
    if (request.body) void request.body.cancel().catch(() => {})
    throw error
  }
}

export async function readBoundedBody(
  request: Request,
  maximum: number,
  timeoutMs = BODY_READ_TIMEOUT_MS,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('invalid body limit')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid body timeout')
  const declared = readDeclaredLength(request, maximum)
  if (!request.body) {
    if (declared !== undefined && declared !== 0)
      throw new InvalidBodyLengthError('invalid body length')
    return new ArrayBuffer(0)
  }
  const output = new Uint8Array(declared ?? maximum)
  const reader = request.body.getReader()
  let length = 0
  let chunks = 0
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyReadTimeoutError('body read timed out')), timeoutMs)
  })
  const read = async () => {
    while (true) {
      const result = await reader.read()
      if (Date.now() - started >= timeoutMs) throw new BodyReadTimeoutError('body read timed out')
      if (result.done) break
      if (++chunks > MAX_BODY_CHUNKS) throw new BodyChunkLimitError('body too fragmented')
      const next = length + result.value.byteLength
      if (next > maximum || (declared !== undefined && next > declared)) {
        if (next > maximum) throw new BodyTooLargeError('body too large')
        throw new InvalidBodyLengthError('invalid body length')
      }
      output.set(result.value, length)
      length = next
    }
  }
  try {
    await Promise.race([read(), timeout])
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
  if (declared !== undefined && length !== declared)
    throw new InvalidBodyLengthError('invalid body length')
  return output.buffer.slice(0, length)
}
