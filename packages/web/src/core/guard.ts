/**
 * Keeps a file dropped outside the editor from opening in place of the page,
 * which would take the room's key in the URL with it. Returns how to let go.
 */
export function guardDrops(target: EventTarget): () => void {
  const hasFiles = (e: Event) => (e as DragEvent).dataTransfer?.types.includes('Files') ?? false
  const prevent = (e: Event) => {
    if (hasFiles(e)) e.preventDefault()
  }
  target.addEventListener('dragover', prevent)
  target.addEventListener('drop', prevent)
  return () => {
    target.removeEventListener('dragover', prevent)
    target.removeEventListener('drop', prevent)
  }
}
