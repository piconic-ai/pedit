import { createSignal, untrack } from '@barefootjs/client'

/** A value that changes over time. */
export interface Readable<T> {
  /** The current value; read in a component's JSX, the component follows it. */
  get(): T
  /** Calls `fn` with each new value; returns a function that stops. */
  subscribe(fn: (value: T) => void): () => void
}

/**
 * State that lives outside the components, such as the room's status: made
 * once by main.ts or a class like TableView, and handed to components, which
 * just read `store.get()` in their JSX. It is backed by a signal created here,
 * outside any component, so reading it tracks it and nothing has to subscribe
 * per component. `subscribe` is for code outside the components.
 */
export class Store<T> implements Readable<T> {
  #read: () => T
  #write: (next: () => T) => void
  #listeners = new Set<(value: T) => void>()

  constructor(value: T) {
    const [read, write] = createSignal(value)
    this.#read = read
    // Wrapped, so a function value is stored rather than called as an update.
    this.#write = (next) => write(next)
  }

  get(): T {
    return this.#read()
  }

  set(value: T): void {
    if (Object.is(value, untrack(this.#read))) return
    this.#write(() => value)
    for (const fn of [...this.#listeners]) fn(value)
  }

  subscribe(fn: (value: T) => void): () => void {
    this.#listeners.add(fn)
    return () => {
      this.#listeners.delete(fn)
    }
  }
}
