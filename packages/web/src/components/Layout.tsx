'use client'

import { onMount } from '@barefootjs/client'

/** Where main.ts puts the room's parts once the page is laid out. */
export interface LayoutParts {
  header: HTMLElement
  /** The room's files, when it shares more than one. */
  files: HTMLElement
  banner: HTMLElement
  notice: HTMLElement
  main: HTMLElement
  /** The editor's box; CodeMirror forces display on .cm-editor, so panes are hidden through it. */
  source: HTMLElement
  preview: HTMLElement
  /** Where the Split divider and the table view go, between and after the panes. */
  splitter: HTMLElement
  table: HTMLElement
  /** Where the canvas board goes. */
  canvas: HTMLElement
  /** The comments of the file on screen, beside it. */
  comments: HTMLElement
}

/**
 * The room page: header, the room's files, the ended banner, notices, and the
 * editor with its panes.
 */
export function Layout(props: { onReady: (parts: LayoutParts) => void }) {
  const parts: Partial<LayoutParts> = {}
  onMount(() => props.onReady(parts as LayoutParts))

  return (
    <div className="layout">
      <div
        className="header-slot"
        ref={(el) => {
          parts.header = el
        }}
      />
      <div
        className="files-slot"
        ref={(el) => {
          parts.files = el
        }}
      />
      <div
        className="banner-slot"
        ref={(el) => {
          parts.banner = el
        }}
      />
      <div
        className="notice-slot"
        ref={(el) => {
          parts.notice = el
        }}
      />
      <main
        className="editor"
        ref={(el) => {
          parts.main = el
        }}
      >
        <div
          className="source"
          ref={(el) => {
            parts.source = el
          }}
        />
        <div
          className="splitter-host"
          ref={(el) => {
            parts.splitter = el
          }}
        />
        <article
          className="preview"
          aria-label="Preview"
          ref={(el) => {
            parts.preview = el
          }}
        />
        <div
          className="table-host"
          ref={(el) => {
            parts.table = el
          }}
        />
        <div
          className="canvas-host"
          ref={(el) => {
            parts.canvas = el
          }}
        />
        <div
          className="comments-host"
          ref={(el) => {
            parts.comments = el
          }}
        />
      </main>
    </div>
  )
}
