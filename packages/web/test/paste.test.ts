// @vitest-environment jsdom
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { imageMarkdown, imagePaste, textAnchor } from '../src/paste.ts'

const views: EditorView[] = []
afterEach(() => {
  for (const v of views.splice(0)) v.destroy()
})

function deferred() {
  let resolve!: (path: string) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(doc: string, blocked: string | null = null) {
  const uploads: ReturnType<typeof deferred>[] = []
  const upload = vi.fn((_file: File) => {
    const d = deferred()
    uploads.push(d)
    return d.promise
  })
  const onError = vi.fn()
  const view = new EditorView({
    doc,
    parent: document.body,
    extensions: imagePaste({ blocked: () => blocked, upload, onError }),
  })
  views.push(view)
  // jsdom lays nothing out, so there is no position under the pointer: a
  // drop goes to the cursor.
  view.posAtCoords = (() => null) as unknown as EditorView['posAtCoords']
  return { view, uploads, upload, onError }
}

const image = (name = 'shot.png') => new File([new Uint8Array([1])], name, { type: 'image/png' })

function dispatch(view: EditorView, type: 'paste' | 'drop', files: File[], types = ['Files']) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  // Enough of DataTransfer for us and for CodeMirror's own paste handling.
  const data = { files, types, getData: () => '' }
  Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: data })
  view.contentDOM.dispatchEvent(event)
  return event
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('imagePaste', () => {
  it('links a pasted image at the cursor once it is saved', async () => {
    const { view, uploads } = setup('ab')
    view.dispatch({ selection: EditorSelection.cursor(1) })
    const event = dispatch(view, 'paste', [image()])
    expect(event.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe('ab')
    uploads[0]?.resolve('assets/0123.png')
    await settle()
    expect(view.state.doc.toString()).toBe('a![](assets/0123.png)b')
  })

  it('keeps the spot while others edit, and before what is typed there', async () => {
    const { view, uploads } = setup('hello world')
    view.dispatch({ selection: EditorSelection.cursor(5) })
    dispatch(view, 'paste', [image()])
    view.dispatch({ changes: { from: 0, insert: '>> ' } })
    view.dispatch({ changes: { from: 8, insert: '!' } })
    uploads[0]?.resolve('assets/x.png')
    await settle()
    expect(view.state.doc.toString()).toBe('>> hello![](assets/x.png)! world')
  })

  it('adds every image pasted at once', async () => {
    const { view, uploads } = setup('')
    dispatch(view, 'paste', [image('a.png'), image('b.png')])
    expect(uploads).toHaveLength(2)
    uploads[0]?.resolve('assets/a.png')
    uploads[1]?.resolve('assets/b.png')
    await settle()
    expect(view.state.doc.toString()).toContain('![](assets/a.png)')
    expect(view.state.doc.toString()).toContain('![](assets/b.png)')
  })

  it('says why an image was not added, and adds nothing', async () => {
    const { view, uploads, onError } = setup('ab')
    dispatch(view, 'paste', [image()])
    uploads[0]?.reject(new Error('The image is too large to add.'))
    await settle()
    expect(onError).toHaveBeenCalledWith('The image is too large to add.')
    expect(view.state.doc.toString()).toBe('ab')
  })

  it('leaves text to the editor', () => {
    const { view, upload } = setup('ab')
    dispatch(view, 'paste', [image()], ['Files', 'text/plain'])
    expect(upload).not.toHaveBeenCalled()
  })

  it('does nothing but explain while images cannot be added', () => {
    const { view, upload, onError } = setup('ab', 'The session has ended.')
    dispatch(view, 'paste', [image()])
    expect(upload).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('The session has ended.')
  })

  it('adds dropped images and keeps other files from leaving the page', async () => {
    const { view, uploads, onError } = setup('ab')
    const other = new File(['x'], 'notes.pdf', { type: 'application/pdf' })
    const event = dispatch(view, 'drop', [other, image()])
    expect(event.defaultPrevented).toBe(true)
    expect(onError).toHaveBeenCalledWith('Only images can be added.')
    uploads[0]?.resolve('assets/x.png')
    await settle()
    expect(view.state.doc.toString()).toContain('![](assets/x.png)')

    const onlyOther = dispatch(view, 'drop', [other])
    expect(onlyOther.defaultPrevented).toBe(true)
    expect(uploads).toHaveLength(1)
  })
})

describe('imageMarkdown', () => {
  it('links the path, bracketing one with spaces or parentheses', () => {
    expect(imageMarkdown('assets/a.png')).toBe('![](assets/a.png)')
    expect(imageMarkdown('my assets/a (1).png')).toBe('![](<my assets/a (1).png>)')
  })
})

describe('imagePaste with an anchor in the shared text', () => {
  it('links the image in the file it was added to, though another is shown by then', async () => {
    const ydoc = new Y.Doc()
    const text = ydoc.getText('content')
    text.insert(0, 'ab')
    const uploads: ReturnType<typeof deferred>[] = []
    const view = new EditorView({
      doc: 'ab',
      parent: document.body,
      extensions: imagePaste({
        blocked: () => null,
        upload: () => {
          const d = deferred()
          uploads.push(d)
          return d.promise
        },
        onError: vi.fn(),
        anchor: (pos) => textAnchor(text, pos),
      }),
    })
    views.push(view)
    view.dispatch({ selection: EditorSelection.cursor(1) })
    dispatch(view, 'paste', [image()])
    // Another file is shown, then this one again, as a fresh state.
    view.setState(EditorState.create({ doc: 'other file' }))
    view.setState(EditorState.create({ doc: 'ab' }))
    // Others edit the file meanwhile, before the image's place and at it.
    text.insert(0, '>')
    text.insert(2, 'typed ')
    uploads[0]?.resolve('assets/x.png')
    await settle()
    expect(text.toString()).toBe('>a![](assets/x.png)typed b')
  })

  it('inserts where its place has moved to', () => {
    const text = new Y.Doc().getText('content')
    text.insert(0, 'ab')
    const anchor = textAnchor(text, 1)
    text.insert(0, 'xx')
    anchor.insert('!')
    expect(text.toString()).toBe('xxa!b')
  })
})
