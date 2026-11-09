/**
 * Maps a selection in the rendered Markdown preview back to the source text,
 * so it can be commented on like a selection in the editor. Blocks carry
 * `data-line` (first source line) and `data-line-end` (the line after the
 * last), see preview.ts; the selected text is then located inside that span.
 */

/** A range of the Markdown text, as offsets. */
export interface SourceRange {
  from: number
  to: number
}

/** The longest start or end fragment looked up when markup splits a selection. */
const FRAGMENT = 40

interface Piece {
  node: Text
  from: number
  to: number
}

const blockOf = (root: Element, node: Node): HTMLElement | null => {
  const el = node instanceof Element ? node : node.parentElement
  const block = el?.closest<HTMLElement>('[data-line]') ?? null
  return block && root.contains(block) ? block : null
}

/** The selected parts of the text nodes under `root`, in order, without blank ones. */
function pieces(root: Element, range: Range): Piece[] {
  const found: Piece[] = []
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text
    if (!range.intersectsNode(node)) continue
    const from = node === range.startContainer ? range.startOffset : 0
    const to = node === range.endContainer ? range.endOffset : node.data.length
    if (to > from && node.data.slice(from, to).trim()) found.push({ node, from, to })
  }
  return found
}

/** The offset of a point in the text of its block. */
function offsetIn(block: Element, node: Node, offset: number): number {
  const r = block.ownerDocument.createRange()
  r.selectNodeContents(block)
  r.setEnd(node, offset)
  return r.toString().length
}

const lineStarts = (source: string): number[] => {
  const starts = [0]
  for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/** Offsets where `needle` starts in `text`, overlapping ones too. */
function occurrences(text: string, needle: string, within: [number, number] = [0, text.length]) {
  const found: number[] = []
  for (let i = text.indexOf(needle, within[0]); i >= 0 && i + needle.length <= within[1]; ) {
    found.push(i)
    i = text.indexOf(needle, i + 1)
  }
  return found
}

/**
 * The occurrence of `needle` in the source span that matches the one in the
 * block's rendered text at `at`: the n-th, counting those before `at`.
 */
function locate(
  block: Element,
  at: number,
  needle: string,
  source: string,
  span: [number, number],
): number | null {
  const found = occurrences(source, needle, span)
  if (found.length === 0) return null
  const rendered = occurrences(block.textContent ?? '', needle)
  const n = rendered.filter((i) => i < at).length
  return found[Math.min(n, found.length - 1)] ?? null
}

/**
 * Where the selection `range`, made in the preview under `root`, is in the
 * Markdown `source`; null when it cannot be placed with confidence: nothing
 * selected, a selection outside the preview or in an embed or the frontmatter,
 * or text the source does not hold as it is shown.
 */
export function previewSelectionToSource(
  root: Element,
  range: Pick<
    Range,
    | 'collapsed'
    | 'startContainer'
    | 'startOffset'
    | 'endContainer'
    | 'endOffset'
    | 'intersectsNode'
    | 'toString'
  >,
  source: string,
): SourceRange | null {
  if (range.collapsed) return null
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const parts = pieces(root, range as Range)
  const first = parts[0]
  const last = parts[parts.length - 1]
  if (!first || !last) return null
  const a = blockOf(root, first.node)
  const b = blockOf(root, last.node)
  if (!a || !b) return null
  for (const block of [a, b]) {
    if (block.closest('.frontmatter, [data-embed-src]')) return null
  }
  const lines = lineStarts(source)
  const span = (block: Element, attr: string): number | null => {
    const n = Number(block.getAttribute(attr))
    if (!block.hasAttribute(attr) || !Number.isInteger(n) || n < 0) return null
    return n >= lines.length ? source.length : (lines[n] ?? null)
  }
  const spanFrom = span(a, 'data-line')
  const spanTo = span(b, 'data-line-end')
  if (spanFrom === null || spanTo === null || spanTo <= spanFrom) return null
  const startAt = offsetIn(a, first.node, first.from)

  if (a === b) {
    // As shown, when the markup does not split it.
    const text = range.toString()
    const hit = text.trim() ? locate(a, startAt, text, source, [spanFrom, spanTo]) : null
    if (hit !== null) return { from: hit, to: hit + text.length }
  }

  // Otherwise the start and the end are found on their own, and the source between is the selection.
  const shown = first.node.data.slice(first.from, first.to)
  const head = shown.trimStart().slice(0, FRAGMENT)
  const headAt = startAt + shown.length - shown.trimStart().length
  const tail = last.node.data.slice(last.from, last.to).trimEnd().slice(-FRAGMENT)
  const from = locate(a, headAt, head, source, [spanFrom, spanTo])
  if (from === null) return null
  const tailAt = offsetIn(b, last.node, last.to) - tail.length
  const end = locate(b, tailAt, tail, source, [span(b, 'data-line') ?? spanFrom, spanTo])
  if (end === null) return null
  const to = end + tail.length
  return to > from ? { from, to } : null
}
