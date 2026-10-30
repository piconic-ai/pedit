// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import { afterEach, expect, it } from 'vitest'
import type { HeaderStatus } from '../src/components/RoomStatusIndicator.tsx'
import '../src/components/RoomStatusIndicator.tsx'
import { Store } from '../src/store.ts'

const mounted: HTMLElement[] = []
afterEach(() => {
  for (const container of mounted.splice(0)) container.remove()
})
function mount(initial: HeaderStatus = 'connected', away?: boolean) {
  const status = new Store<HeaderStatus>(initial),
    container = document.createElement('div')
  document.body.append(container)
  mounted.push(container)
  const hostAway = new Store(away ?? false)
  render(container, 'RoomStatusIndicator', {
    status,
    hostAway: away === undefined ? undefined : hostAway,
  })
  const button = container.querySelector<HTMLButtonElement>('.status'),
    tooltip = container.querySelector<HTMLElement>('[role="tooltip"]'),
    wrapper = container.querySelector<HTMLElement>('.room-status')
  if (!button || !tooltip || !wrapper) throw new Error('status controls unavailable')
  const hover = (on: boolean) =>
    wrapper.dispatchEvent(new MouseEvent(on ? 'mouseenter' : 'mouseleave'))
  const visible = () => wrapper.dataset.open === 'true'
  return { container, status, hostAway, button, tooltip, wrapper, hover, visible }
}
it('uses a shared compact status control with an accessible explanation', () => {
  const x = mount()
  expect(x.button.dataset.status).toBe('connected')
  expect(x.button.textContent).toBe('Connected')
  expect(x.button.querySelector('.dot')).toBeTruthy()
  expect(x.button.getAttribute('aria-describedby')).toBe(x.tooltip.id)
  expect(x.tooltip.textContent).toContain('does not confirm')
  expect(x.visible()).toBe(false)
})
it('shows on hover or keyboard focus, survives hovering the tooltip, and dismisses on Escape', () => {
  const x = mount()
  x.hover(true)
  expect(x.visible()).toBe(true)
  x.tooltip.dispatchEvent(new MouseEvent('mouseenter'))
  expect(x.visible()).toBe(true)
  x.button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(x.visible()).toBe(false)
  x.hover(false)
  x.hover(true)
  expect(x.visible()).toBe(true)
  x.hover(false)
  expect(x.visible()).toBe(false)
  x.button.focus()
  expect(x.visible()).toBe(true)
  x.button.blur()
  expect(x.visible()).toBe(false)
})
it('keeps the explanation while either hover or focus remains, and Escape also dismisses hover-only', () => {
  const x = mount()
  x.hover(true)
  x.button.focus()
  x.button.blur()
  expect(x.visible()).toBe(true)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(x.visible()).toBe(false)
  x.hover(false)
  x.hover(true)
  expect(x.visible()).toBe(true)
  x.hover(false)
  expect(x.visible()).toBe(false)
})
it('toggles for touch clicks even when focus occurs between pointerdown and click', () => {
  const x = mount('kept')
  x.button.dispatchEvent(new Event('pointerdown'))
  x.button.focus()
  x.button.click()
  expect(x.visible()).toBe(true)
  x.button.dispatchEvent(new Event('pointerdown'))
  x.button.click()
  expect(x.visible()).toBe(false)
})
it('updates labels, icons and explanations when either transport status changes', () => {
  const x = mount('connecting')
  expect(x.button.textContent).toBe('Connecting…')
  x.status.set('kept')
  expect(x.button.textContent).toBe('Edits kept')
  expect(x.tooltip.textContent).toContain('relay')
  expect(x.tooltip.textContent).toContain('host')
  x.status.set('synced')
  expect(x.tooltip.textContent).toContain('host’s file')
  expect(x.button.dataset.tone).toBe('ok')
  x.status.set('saving')
  expect(x.button.dataset.tone).toBe('working')
  x.status.set('expired')
  expect(x.button.textContent).toBe('Time limit')
  expect(x.tooltip.textContent).toContain('ended')
})
it('assigns distinct tooltip descriptions to multiple mounted headers', () => {
  const first = mount(),
    second = mount()
  expect(first.tooltip.id).not.toBe(second.tooltip.id)
})

it('keeps the same cloud while the dot follows host presence independently of saved status', () => {
  const x = mount('kept', true)
  const cloud = x.button.querySelector('path')?.getAttribute('d')
  expect(x.button.dataset.icon).toBe('cloud')
  expect(x.button.dataset.host).toBe('away')
  expect(x.button.querySelector('.host-dot')).not.toBeNull()
  expect(x.tooltip.textContent).toContain('host is away')
  x.hostAway.set(false)
  expect(x.button.dataset.host).toBe('online')
  expect(x.button.querySelector('path')?.getAttribute('d')).toBe(cloud)
  expect(x.tooltip.textContent).toContain('host is online')
  expect(x.tooltip.textContent).toContain('waiting for the host to save')
  x.status.set('synced')
  expect(x.button.querySelector('path')?.getAttribute('d')).toBe(cloud)
  expect(x.tooltip.textContent).toContain('host’s file')
})
it('uses the same cloud for connected and waiting live rooms', () => {
  const x = mount()
  const cloud = x.button.querySelector('path')?.getAttribute('d')
  expect(x.button.dataset.host).toBe('online')
  x.status.set('waiting')
  expect(x.button.dataset.host).toBe('away')
  expect(x.button.querySelector('path')?.getAttribute('d')).toBe(cloud)
})
