import { Store } from './store.ts'

const SHOW_MS = 6000

/** Short messages about what just happened, such as an image that could not be added. */
export class NoticeBoard {
  readonly message = new Store<string | null>(null)
  #timer: ReturnType<typeof setTimeout> | undefined
  #showMs: number

  constructor(showMs = SHOW_MS) {
    this.#showMs = showMs
  }

  /** Shows a message for a few seconds, replacing the one before. */
  show(message: string): void {
    clearTimeout(this.#timer)
    this.message.set(message)
    this.#timer = setTimeout(() => this.message.set(null), this.#showMs)
  }

  dismiss(): void {
    clearTimeout(this.#timer)
    this.message.set(null)
  }
}
