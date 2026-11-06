/**
 * Guards the edge of `src/core/`.
 *
 * The core is shared by the relay's editor and a `<pedit-review>` web
 * component that runs inside a shadow root on another app's page (see
 * docs/design/embedding.md, "Review core"). There it must not reach for the
 * page it sits in: another app's URL, storage, history, title or elements. So a
 * core file may only import npm packages, `@pedit/protocol` and other core
 * files, and must take everything from the page as an argument.
 *
 * The files are parsed, not grepped, so strings and comments never trip the
 * rules and a property named `location` on some object is fine.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const core = resolve(import.meta.dirname, '../src/core')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sources(path)
    return /\.tsx?$/.test(e.name) ? [path] : []
  })
}

/** Globals that are the page itself; a core file must not name them. */
const PAGE_GLOBALS = new Set([
  'window',
  'self',
  'globalThis',
  'location',
  'localStorage',
  'sessionStorage',
  'history',
  'top',
  'parent',
  'opener',
  'frames',
])

/** What a core file may use of `document`: making nodes, never finding or reading the page's. */
const DOCUMENT_ALLOWED = new Set([
  'createElement',
  'createElementNS',
  'createTextNode',
  'createDocumentFragment',
  'createRange',
])

/** Whether an identifier is a value reference: not a property name, a declaration or a type. */
function isReference(id: ts.Identifier): boolean {
  // Types are erased: `globalThis.Clipboard` in a type reads nothing from the page.
  for (let n: ts.Node = id; n.parent; n = n.parent) if (ts.isTypeNode(n)) return false
  const p = id.parent
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessor(p) ||
      ts.isSetAccessor(p) ||
      ts.isEnumMember(p) ||
      ts.isBindingElement(p) ||
      ts.isJsxAttribute(p)) &&
    p.name === id
  )
    return false
  return true
}

/** Names the file declares itself (variables, parameters, functions, imports), which shadow globals. */
function declared(file: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isBindingElement(node) ||
        ts.isImportSpecifier(node) ||
        ts.isImportClause(node) ||
        ts.isNamespaceImport(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      names.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return names
}

interface Problems {
  imports: string[]
  page: string[]
}

function check(path: string): Problems {
  const text = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const own = declared(file)
  const problems: Problems = { imports: [], page: [] }

  const specifier = (node: ts.Expression | undefined): void => {
    if (!node) return
    if (!ts.isStringLiteralLike(node)) {
      problems.imports.push(`non-literal import: ${node.getText(file)}`)
      return
    }
    const spec = node.text
    if (spec.startsWith('.')) {
      if (relative(core, resolve(dirname(path), spec)).startsWith('..')) problems.imports.push(spec)
    } else if (spec.startsWith('/') || spec.startsWith('src/') || spec.startsWith('~')) {
      problems.imports.push(spec)
    } else if (spec.startsWith('@pedit/') && !/^@pedit\/protocol(\/|$)/.test(spec)) {
      problems.imports.push(spec)
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier(node.moduleSpecifier)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier(node.arguments[0])
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier(node.argument.literal as ts.Expression)
    } else if (ts.isIdentifier(node) && isReference(node) && !own.has(node.text)) {
      if (PAGE_GLOBALS.has(node.text)) problems.page.push(node.text)
      if (node.text === 'document') {
        const p = node.parent
        const member =
          ts.isPropertyAccessExpression(p) && p.expression === node ? p.name.text : null
        if (!member || !DOCUMENT_ALLOWED.has(member))
          problems.page.push(member ? `document.${member}` : 'document')
      }
    } else if (ts.isStringLiteralLike(node) && /#app\b/.test(node.text)) {
      problems.page.push('#app')
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return problems
}

const files = sources(core)

describe('src/core boundary', () => {
  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    const name = relative(core, file).split(sep).join('/')
    const problems = check(file)

    it(`${name} imports nothing outside core`, () => {
      expect(problems.imports).toEqual([])
    })

    it(`${name} does not read the page it runs in`, () => {
      expect(problems.page).toEqual([])
    })
  }
})
