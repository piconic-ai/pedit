import { createRoot } from '@barefootjs/client'
import { render } from '@barefootjs/client/runtime'

/**
 * Renders a registered component into `parent` under a reactive root, so the
 * effects and cleanups it makes (timers, store subscriptions) end when the
 * returned function is called. The runtime's `render` has no teardown of its own.
 */
export function mountComponent(
  parent: HTMLElement,
  name: string,
  props: Record<string, unknown>,
): () => void {
  let stop = () => {}
  createRoot((dispose) => {
    stop = dispose
    render(parent, name, props)
  })
  return () => {
    stop()
    parent.replaceChildren()
  }
}
