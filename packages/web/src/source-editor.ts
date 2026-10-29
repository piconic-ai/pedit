import { markdown } from '@codemirror/lang-markdown'
import type { Extension } from '@codemirror/state'
import { basicSetup } from 'codemirror'

export const defaultSourceLanguage = () => markdown()

// Shared display and interaction setup. Collaboration, undo, and file-specific
// behaviour remain supplied by the caller for its room protocol.
export function sourceEditorExtensions(options: {
  vim: Extension
  undo: Extension
  language: Extension
  theme: Extension
  font: Extension
  wrap: Extension
  editable: Extension
  collaboration: Extension
  comments: Extension
  selection: Extension
  paste: Extension
}): Extension[] {
  return [
    options.vim,
    basicSetup,
    options.undo,
    options.language,
    options.theme,
    options.font,
    options.wrap,
    options.editable,
    options.collaboration,
    options.comments,
    options.selection,
    options.paste,
  ]
}
