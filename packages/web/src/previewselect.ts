/**
 * Maps a selection in the rendered Markdown preview back to the source text,
 * so it can be commented on like a selection in the editor. preview.ts gives
 * each run of visible text the offset where it starts in the source
 * (`data-src`); a run is shown verbatim, so a position in it is a position in
 * the source. A boundary outside any such run, or in a run the source does not
 * hold as shown, is not guessed at: the selection cannot be placed.
 */

/** A range of the Markdown text, as offsets. */
export interface SourceRange {
  from: number
  to: number
}

type Selected = Pick<
  Range,
  | 'collapsed'
  | 'startContainer'
  | 'startOffset'
  | 'endContainer'
  | 'endOffset'
  | 'intersectsNode'
  | 'toString'
>

const runOf = (root: Element, node: Node): HTMLElement | null => {
  const el = node instanceof Element ? node : node.parentElement
  const run = el?.closest<HTMLElement>('[data-src]') ?? null
  return run && root.contains(run) ? run : null
}

/** The source offset of a point in a text node, or null when its run is not mapped. */
function sourceAt(root: Element, node: Node, offset: number): number | null {
  const run = runOf(root, node)
  const start = run ? Number(run.getAttribute('data-src')) : Number.NaN
  if (!run || !Number.isInteger(start)) return null
  const r = run.ownerDocument.createRange()
  r.selectNodeContents(run)
  r.setEnd(node, offset)
  return start + r.toString().length
}

/** The selected parts of the text nodes under `root`, in order, without blank ones. */
function pieces(root: Element, range: Selected): { node: Text; from: number; to: number }[] {
  const found: { node: Text; from: number; to: number }[] = []
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

/** `offset` in `node`, moved by `step` if it is inside a surrogate pair. */
function whole(node: Text, offset: number, step: -1 | 1): number {
  const before = node.data.charCodeAt(offset - 1)
  const after = node.data.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
    ? offset + step
    : offset
}

/** Whether the non-blank characters of `text` appear in order in `within`. */
function inOrder(text: string, within: string): boolean {
  let at = 0
  for (const c of text) {
    if (/\s/.test(c)) continue
    at = within.indexOf(c, at) + 1
    if (at === 0) return false
  }
  return true
}

/**
 * Where the selection `range`, made in the preview under `root`, is in the
 * Markdown `source`; null when it cannot be placed exactly: nothing selected,
 * a selection outside the preview or in an embed or the frontmatter, or one
 * that starts or ends in text the source does not hold as it is shown.
 */
export function previewSelectionToSource(
  root: Element,
  range: Selected,
  source: string,
): SourceRange | null {
  if (range.collapsed) return null
  const { startContainer: sc, endContainer: ec } = range
  if (!root.contains(sc) || !root.contains(ec)) return null
  const parts = pieces(root, range)
  const first = parts[0]
  const last = parts[parts.length - 1]
  if (!first || !last) return null
  for (const node of [first.node, last.node, sc, ec]) {
    const el = node instanceof Element ? node : node.parentElement
    if (el?.closest('.frontmatter, [data-embed-src]')) return null
  }
  // A boundary inside a run is exact. One at a run's edge (the end of the text
  // a selection starts in, the start of the one it ends in) or between blocks
  // moves to the nearest text inside the selection, past blanks.
  const inRun = (node: Node) => node.nodeType === Node.TEXT_NODE && runOf(root, node) !== null
  let from: number | null
  if (inRun(sc) && range.startOffset < (sc as Text).data.length) {
    from = sourceAt(root, sc, whole(sc as Text, range.startOffset, -1))
  } else {
    const lead = first.node.data.length - first.node.data.slice(first.from).trimStart().length
    from = sourceAt(root, first.node, whole(first.node, Math.max(first.from, lead), -1))
  }
  let to: number | null
  if (inRun(ec) && range.endOffset > 0) {
    to = sourceAt(root, ec, whole(ec as Text, range.endOffset, 1))
  } else {
    const end = last.from + last.node.data.slice(last.from, last.to).trimEnd().length
    to = sourceAt(root, last.node, whole(last.node, end, 1))
  }
  if (from === null || to === null || to <= from) return null
  // The blanks at the ends of the selection are not what is quoted.
  while (from < to && /\s/.test(source[from] ?? '')) from++
  while (to > from && /\s/.test(source[to - 1] ?? '')) to--
  if (to <= from) return null
  return inOrder(range.toString(), source.slice(from, to)) ? { from, to } : null
}
