import { markdownLanguage } from '@codemirror/lang-markdown'
import { defaultHighlightStyle } from '@codemirror/language'
import { highlightTree } from '@lezer/highlight'
import { describe, expect, it } from 'vitest'

describe('Markdown highlighting', () => {
  // Two copies of @lezer/common in the lockfile give the parser's node props
  // and the highlighter's the same ids, and highlighting then throws: the
  // file's editor and a canvas card's showed no colours. `pnpm dedupe` fixes it.
  it('styles a heading and strong text, as the editors show them', () => {
    const text = '# Title\n\n**bold**'
    const tree = markdownLanguage.parser.parse(text)
    const styled: string[] = []
    highlightTree(tree, defaultHighlightStyle, (from, to) => styled.push(text.slice(from, to)))
    expect(styled).toEqual(expect.arrayContaining([' Title', 'bold']))
  })
})
