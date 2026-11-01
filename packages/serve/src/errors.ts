/** Another process (maybe another app) serves the file. The labels come from a lock file: never signal the pid. */
export class HeldError extends Error {
  holder: { pid: number; app?: string }
  constructor(holder: { pid: number; app?: string }) {
    super('the file is served by another process')
    this.name = 'HeldError'
    this.holder = holder
  }
}

/** A hard limit was reached: 32 files, or 8 clients per file. */
export class LimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LimitError'
  }
}

/** The pedit binary is missing or not trustworthy. */
export class NoPeditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoPeditError'
  }
}
