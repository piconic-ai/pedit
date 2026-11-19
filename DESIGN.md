---
version: alpha
name: pedit-editor
description: The browser editor of pedit, a tool for editing a local file together. Quiet chrome around three surfaces (Markdown source and preview, a CSV table, a canvas board). Ink, hairlines and one accent, all taken from the reader's editor theme; the only other colour on screen belongs to people (cursors, chips) and to comments.

# Colours are the default theme (GitHub Light). They are examples, not constants:
# packages/web/src/palette.ts derives the same roles for each of the 12 themes,
# and CSS must read the custom properties named in "Colors" below, never these values.
colors:
  canvas: "#f6f8fa"
  surface: "#ffffff"
  ink: "#24292e"
  mute: "#656d76"
  hairline: "#d0d7de"
  accent: "#0969da"
  on-accent: "#ffffff"
  code-tint: "#afb8c133"
  warn-surface: "#f9ecdf"
  warn-ink: "#8a4308"
  comment-mark: "#e8a317"
  presence-online: "#00b769"

typography:
  title:
    fontFamily: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif
    fontSize: 16px
    fontWeight: 600
    lineHeight: 24px
  body:
    fontFamily: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
  ui:
    fontFamily: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
  ui-strong:
    fontFamily: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif
    fontSize: 13px
    fontWeight: 600
    lineHeight: 20px
  label:
    fontFamily: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
  caption:
    fontFamily: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif
    fontSize: 11px
    fontWeight: 600
    lineHeight: 16px
  mono-label:
    fontFamily: ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px

rounded:
  none: 0px
  xs: 4px
  sm: 6px
  md: 8px
  full: 999px

spacing:
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  5: 24px
  6: 32px

components:
  header:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    height: 44px
    padding: 8px 12px
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.ui-strong}"
    rounded: "{rounded.sm}"
    height: 28px
    padding: 0px 12px
  button-secondary:
    backgroundColor: transparent
    textColor: "{colors.mute}"
    typography: "{typography.ui}"
    rounded: "{rounded.sm}"
    height: 28px
    padding: 0px 10px
  button-icon:
    backgroundColor: transparent
    textColor: "{colors.mute}"
    rounded: "{rounded.sm}"
    size: 28px
  segmented:
    textColor: "{colors.mute}"
    typography: "{typography.ui}"
    rounded: "{rounded.sm}"
    height: 28px
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    height: 32px
    padding: 0px 8px
  floating-surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  menu-item:
    typography: "{typography.ui}"
    rounded: "{rounded.xs}"
    height: 28px
    padding: 0px 8px
  participant-chip:
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    height: 22px
---

## Overview

pedit's editor is a guest's view of someone else's local file. A person opens a link, types a name and is inside the document within seconds, usually for one short session. The chrome exists to answer three questions at a glance (which file, who is here, is it connected) and then to stay out of the way.

The visual system is stark by design: one surface colour for panels, one darker step behind them, one ink, one muted ink, one hairline, one accent. All six come from the editor theme the reader picked, so the chrome and the text they are editing never disagree. Depth comes from hairlines; only things that float above the page (menus, popovers, the comment composer) carry a shadow.

Mono type marks the technical layer: the file name, the source, table cells, key hints. Everything a person reads as interface is in the system sans.

**Key characteristics**

- **The document is the protagonist.** Chrome is one 44px row. No sidebars open by default except what the reader asked for.
- **Colour means a person or a comment.** Peer colours (cursors, selections, chips) and the amber comment mark are the only saturated colour on screen apart from the accent. The accent is for focus, selection, links, the current tab and the one primary action in a dialog.
- **One recipe per kind of thing.** Every control is 28px tall with a 6px radius. Every floating surface is the same panel: hairline, 8px radius, one shadow.
- **Theme-derived, never hard-coded.** Twelve themes, light and dark. A rule that names a hex value is a bug.
- **Weight 600 is the ceiling** outside the brand word and Markdown content.

## Colors

CSS reads these custom properties. `packages/web/src/page/base.css` holds the defaults (GitHub Light and Dark through `light-dark()`); `palette.ts` overwrites them on the root when the reader picks a theme; `packages/review/src/host.css` maps them for the `<pedit-review>` element.

### Surface

| Role | Property | Use |
|---|---|---|
| canvas | `--bg` | Behind the panels: the page, the comments column, the board, input fields, the pressed segment, a hovered menu item. |
| surface | `--panel` | Header, editor, preview, table, floating surfaces, canvas cards. Equal to the editor theme's background. |
| hairline | `--line` | Every border and divider, 1px. |

### Text

| Role | Property | Use |
|---|---|---|
| ink | `--ink` | Text, and icons on hover or when pressed. |
| mute | `--muted` | Secondary text, resting icons, placeholders, the file name. `palette.ts` keeps it at 4.5:1 on the panel. |

### Accent

| Role | Property | Use |
|---|---|---|
| accent | `--accent` | Focus rings, the reader's own selection outline in the table and board, links, the underline of the current tab, a pressed toggle icon, the fill of the primary button. |
| on-accent | `--panel` | Text on the primary button. `palette.ts` keeps the accent at 4.5:1 against the panel, so the panel colour reads on an accent fill. |

### Semantic

| Role | Property | Use |
|---|---|---|
| comment | `--comment-mark` | Where a comment is: marks in the text, corners on cells and nodes, the count badge. Nothing else is amber. |
| online | `--pedit-green` | The host-is-online dot and the brand favicon. Nothing else is green. |
| warning | `--warn-bg`, `--warn-ink` | Banners that say the room ended, the host left, a limit was reached. |
| danger | add `--danger` and `--on-danger` | The confirm step of deleting a comment. Today this is a raw `#cf222e`; it needs a variable so themes and the embed can set it. |
| peer | `--peer`, `--peer-color` (set inline per person) | A person's cursor, selection, cell or node outline, chip and avatar. Text on a peer colour is white; `identity.ts` owns the list and its contrast. |

Rules:

- No hex, `rgb()` or named colour in any file but `base.css` (and `host.css` for the embed). Translucent steps are made with `color-mix(in srgb, var(--ink) N%, transparent)` or an existing variable.
- Never use the accent as a background for a region, a hover state or a chip.
- Hover on a quiet control changes its text from mute to ink and shows its hairline; it does not fill with colour.

## Typography

### Font family

- Sans: `var(--sans)`. The system stack, with Hiragino Sans and Noto Sans JP named so Japanese text has even weight. No web fonts: the page's Content-Security-Policy and the "nothing but the relay" promise rule them out.
- Mono: `var(--mono)`.

### Hierarchy

Define these on the root in `base.css` and use nothing else in chrome:

| Token | Value | Weight | Use |
|---|---|---|---|
| `--text-lg` | 1rem (16px) | 600 | Dialog titles ("Join the room"). |
| `--text-md` | 0.875rem (14px) | 400 | Body: comment text, dialog copy, input text. |
| `--text-sm` | 0.8125rem (13px) | 400, 600 when pressed or primary | Controls: buttons, segments, menu items, tabs, the file name (mono). |
| `--text-xs` | 0.75rem (12px) | 400 | Labels and hints: participant chips, field help, timestamps, key hints. |
| `--text-2xs` | 0.6875rem (11px) | 600 | Count badges, avatar initials, uppercase section labels in Settings. |

- The editor and the table follow the reader's settings (`--editor-font-size`, `--editor-line-height`); the gutter is one pixel smaller. Do not touch these.
- Rendered Markdown in the preview keeps its relative sizes (`em`, `%`): it is content, and it scales with the reader's setting.
- Line height is 20px for 13 and 14px text, 16px for 11 and 12px, 24px for 16px.
- No negative letter-spacing. Chrome text is small, and Japanese text loses legibility when tightened. Uppercase section labels in Settings may keep `0.04em`.
- Sentence case everywhere. No all-caps outside those section labels.
- iOS: any focusable field stays at 16px or more (see the `@supports (-webkit-touch-callout: none)` block in `base.css`).

## Layout

### Spacing

Base unit 4px. Tokens `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 24 · `--space-6` 32. Gaps of 2px between segments of one control and 6px inside a chip are the two exceptions that exist today; add no others.

- Header: `--space-2` vertical, `--space-3` horizontal, `--space-2` between controls, `--space-3` between groups (file · status and people · view · actions).
- Floating panel with a form (Settings): `--space-3` padding. Menu: `--space-1` padding.
- Comments column: `--space-3` padding, `--space-2` between threads.
- Editor text starts `--space-4` from the top of its pane; the preview has `--space-5` on each side.

### Control heights

| Token | Value | Use |
|---|---|---|
| `--control-sm` | 28px | Every control in the header, menu items, tabs, comment actions. |
| `--control-md` | 32px | Inputs and the buttons beside them (Join, the comment composer). |
| `--control-touch` | 44px | Any of the above under `(pointer: coarse)`. |

### Panes

- The header is always one row. It never wraps. When it runs out of room, things give way in this order: the brand word hides; the file name shrinks to its first 8 characters and an ellipsis; participants fold to overlapping faces; Share and About move into the Settings panel. The view switch and the comments button are the last to go.
- In Split, source and preview each keep at least 320px. The preview's text column is at most 820px and is centred in its pane whenever the pane is wider.
- The comments column is 280px. It sits beside the document only when that leaves every pane its minimum; otherwise it lays over the right edge of the document as a floating surface. At 720px and below it is the bottom sheet it is today.
- The table and the board fill their pane. The table's sheet starts at the top left; the area beyond it is `--bg`.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| 0 | No border, no shadow. | Editor, preview, table, board. |
| 1 | 1px `--line`. | Header bottom, pane dividers, the comments column, inputs, the segmented control, comment threads, canvas cards. |
| 2 | 1px `--line` and `--shadow-float`. | Anything that floats: Settings, About, Share and context menus, the status tooltip, the comment composer, the comments column when it overlays. |

Two shadow tokens, defined once in `base.css`:

- `--shadow-raise`: `0 1px 2px rgb(0 0 0 / 0.10)`. Small things that sit on the text: the "add a comment" button by a selection, a dragged card.
- `--shadow-float`: `0 1px 1px rgb(0 0 0 / 0.04), 0 8px 16px -4px rgb(0 0 0 / 0.12), 0 24px 32px -8px rgb(0 0 0 / 0.10)`. Level 2. Stacked small offsets, never one heavy blur.

Rings are not shadows in this sense: a focus ring, a selected cell and a peer's outline are `0 0 0 2px` in a colour variable, or an `outline`.

Layers: `--z-float: 20` for level 2 surfaces, `--z-top: 100` for tooltips and notices. Numbers below 10 are local stacking inside a component and stay literal.

## Shapes

| Token | Value | Use |
|---|---|---|
| `--radius-xs` | 4px | Menu items, inline code, key hints, the comment corner, small marks. |
| `--radius-sm` | 6px | Every control: buttons, icon buttons, inputs, the segmented control, tabs' focus shape, banners. |
| `--radius-md` | 8px | Floating surfaces, comment threads, canvas cards, theme swatches. |
| `--radius-full` | 999px | Things that stand for a person or a count: avatars (or `50%`), participant chips, access chips, badges. |

No button is a pill. A pill says "person" here.

## Components

### Header

One row, 44px, `--panel` with a bottom hairline. Left to right: brand word (sans, 16px, 700, the only 700 in chrome), file name (mono, `--text-sm`, mute, takes the free space and truncates), room status, access chip when the link is below edit, participants, view switch, Share, comments toggle, Settings, About.

### Buttons

- **Primary** (`button-primary`): accent fill, `--panel` text, `--text-sm` 600, `--radius-sm`. One per dialog or composer at most: Join, Comment, Reply, Save. Height `--control-md` beside an input, `--control-sm` elsewhere.
- **Secondary** (`button-secondary`): transparent, 1px `--line`, mute text that turns ink on hover. Share, Cancel, Load.
- **Quiet text**: no border, mute text, ink on hover, same height and padding as secondary. For the lesser of two actions when a border would be noise (Cancel next to a primary in the composer).
- **Icon** (`button-icon`): 28px square, transparent border that shows `--line` on hover and focus, icon 18px with a 2px stroke in `currentColor`. A toggle that is on (`aria-pressed="true"`) shows its icon in the accent.
- **Danger**: as primary, in `--danger` and `--on-danger`. Only on the confirm step.
- Disabled: mute text, no hover, `cursor: default`. Never lower the opacity of text below what `palette.ts` guarantees.

### Segmented control (view switch)

A 1px hairline box, `--radius-sm`, segments divided by hairlines. Resting segment: mute. Pressed: `--bg` fill, ink, 600. It is the only place a pressed state fills. The canvas board's "view as JSON" belongs here as a second segment pair (Board · JSON), like Text · Table for CSV, not as a floating button on the board.

### Inputs

`--bg` fill, 1px `--line`, `--radius-sm`, `--control-md`, `--text-md` (16px on iOS). Focus: the ring below, and the border takes the accent. Placeholder in mute. Sliders and checkboxes use `accent-color: var(--accent)`.

### Floating surface

One class does all of them. `--panel`, 1px `--line`, `--radius-md`, `--shadow-float`, `--z-float`. It opens 4px from its trigger, aligned to the trigger's edge, and is kept 8px inside the viewport.

- **Menu** (Share, the row and column menu, About): `--space-1` padding. Items are 28px, `--text-sm`, `--radius-xs`, `--space-2` horizontal padding, an optional 16px icon at the start and a key hint in `--text-xs` mute at the end. Hover and keyboard focus fill the item with `--bg`. Separators are a hairline with `--space-1` above and below.
- **Panel** (Settings): `--space-3` padding. Section labels are `--text-2xs` 600 mute uppercase. A row that opens a sub-page (Theme) is a menu item with a chevron.
- **Tooltip** (room status): `--space-2` `--space-3` padding, `--text-xs`, at most 320px wide, `--z-top`.
- **Composer** (comment on a selection): `--space-2` padding; a textarea, then Cancel (quiet) and Comment (primary) aligned to the end. It opens beside the selection it is about, on the side with more room, and never covers that selection.

Escape closes any floating surface and returns focus to its trigger. A click outside closes it. Only one is open at a time.

### Participants

A chip per person: 22px, `--radius-full`, the person's colour, white `--text-xs` text, an 18px avatar at the start. The reader's own chip says "(you)" and the host's "(host)". Chips are not buttons and get no hover state. Folded (narrow), they are 24px faces that overlap by 6px with a 2px `--panel` ring.

### Comments

- Column: `--bg`, a left hairline, 280px. A title in `--text-sm` 600, then tabs.
- Tabs (Open, Resolved, and the file tabs): `--text-sm`, mute; the current one is ink with a 2px accent underline. No box, no fill.
- Thread: `--panel`, 1px `--line`, `--radius-md`, `--space-3` padding. The current thread adds `--shadow-raise` and its quote takes the comment colour. The quote is a 2px `--comment-mark` bar at the start and `--text-xs` mute text, clamped to two lines.
- Empty state: one sentence in `--text-sm` mute. No illustration.
- "Add a comment" appears at the end of the selection, not at the end of the line: a 24px icon button on `--panel` with `--shadow-raise`.

### Editor

The source is CodeMirror with the reader's theme. Chrome rules for it:

- The gutter has the editor's own background and mute numbers; it must not show CodeMirror's base gutter colours. No border between gutter and text.
- The reader's selection must stay visible on the active line in every theme.
- A peer's caret is 2px in their colour with their name on a flag above it (`--text-2xs`, white on their colour, `--radius-xs`); the flag fades after a moment and returns on hover.

### Table (CSV)

Cells in mono at the editor's size, 1px hairlines, header row and the row and column labels on `--bg` in `--text-xs` mute. The selected cell has a 2px accent outline inside the cell; a peer's cell has theirs in the peer colour with the name flag. The cell editor keeps the cell's box exactly; nothing shifts when editing starts.

### Canvas

Board on `--bg`. Cards are `--panel`, 1px border in the card's colour (or `--line`), `--radius-md`, title in `--text-lg` 600 with a hairline under it, body in `--text-md`. A selected card has a 2px accent ring outside its border and shows its resize handles; a peer's selection is the same ring in their colour. Edges are 1.5px mute, 2px accent when selected.

### Banners and notices

A banner is a full-width row under the header: `--warn-bg`, `--warn-ink`, `--text-sm`, `--space-2` `--space-4` padding, an action on the right as a secondary button in the same ink. A notice ("Edit link copied.") is a tooltip-shaped floating surface at the bottom centre that leaves after a few seconds and is announced through `role="status"`.

### Join dialog

Centred card on `--bg`: `--panel`, hairline, `--radius-md`, `--space-4` padding, at most 360px. Title `--text-lg` 600, one line of `--text-md` mute, then the input and the primary button on one row, both `--control-md`.

### Focus

Every focusable thing shows `outline: 2px solid var(--accent); outline-offset: 2px` on `:focus-visible` (`-2px` inside tight grids such as table cells and menu items, where `--bg` fill is used instead). `outline: none` is allowed only when the same rule gives another visible cue.

### Motion

`--motion-fast: 120ms` with `ease-out`, on `color`, `background-color`, `border-color` and `opacity` only. Floating surfaces appear without a transform. Under `prefers-reduced-motion: reduce`, none of it runs. Nothing animates while the reader types.

## Do's and Don'ts

### Do

- Read every colour from a custom property, so all twelve themes and the embed keep working.
- Use the tokens: `--text-*`, `--space-*`, `--radius-*`, `--control-*`, `--shadow-*`, `--z-*`.
- Give a new control the shape of the nearest existing one before inventing a recipe.
- Keep hover quiet: mute to ink, transparent to hairline.
- Keep saturated colour for people and comments.
- Check both schemes, and at 1440, 800 and 375px wide, before calling a change done.
- Keep `src/core/css/` free of `:root`, `html`, `body`, `#app` and `*` rules and of custom property defaults (`test/core-css.test.ts`); add a new token to `base.css` and to `packages/review/src/host.css` together.

### Don't

- Don't add a web font, an icon font, an image or a gradient.
- Don't make a button a pill, or give a control a radius of its own.
- Don't add a second accent, a tinted panel or a coloured hover.
- Don't use a shadow to separate things that sit on the page; that is the hairline's job.
- Don't let the header wrap.
- Don't change `--editor-font-size`, `--editor-line-height` or the Markdown preview's content styles in the name of the scale.
- Don't replace pedit's CSS with BarefootJS's ready-made UI components (AGENTS.md).
- Don't animate layout, and don't animate anything while the reader types.

## Responsive Behavior

| Width | What changes |
|---|---|
| above 1000px | Split shows source and preview; the comments column sits beside them. |
| 721 to 1000px | Split keeps both panes at 320px or more; the comments column overlays the right edge instead of taking a third column. The header drops the brand word, then shortens the file name. |
| 720px and below | Split is not offered (Edit and Preview only). Participants fold to faces. Comments are a bottom sheet. Share and About live in Settings. |
| `(pointer: coarse)` | Every control is 44px in its smaller dimension; hit areas grow, visuals do not. |

The breakpoint in the code today is 720px; keep that number. Prefer a container query on the layout for the 1000px rule, so the embed, whose host decides its width, behaves the same.

## Iteration Guide

1. Change one component or one rule at a time; keep each change small enough to review as one commit.
2. Read the component's CSS and its test before editing. Many rules exist because of a phone or a screen reader; the comment above the rule says so.
3. Replace literals with tokens first, with no visual change intended; then change the look.
4. After every change run `node design-loop/tools/design-audit.mjs`; the count never goes up.
5. Look at the result in the browser in light and dark at 1440, 800 and 375px. A passing audit is not a passing design.
6. Where a rule here turns out to be wrong for pedit, change this file in the same commit and say why.

## Known Gaps

- No decision yet on a danger colour per theme; `--danger` starts as a fixed red in both schemes.
- The landing page, the legal pages and the theme previews in Settings are outside this document.
- The peer colour list and its contrast live in `identity.ts` and are not specified here.
- The 1000px rule and the header's give-way order describe behaviour that does not exist yet; the numbers may need tuning once built.
- xyflow's own controls (`src/components/xyflow/`) are a registry copy and are styled only through pedit's rules around them.

## Source

Adapted from the Vercel analysis at getdesign.md (VoltAgent/awesome-design-md, MIT): its ink, hairline and canvas roles, the 4px grid, the 6px control radius, hairline-first depth with stacked shadows on floating layers only, mono for the technical layer and the weight ceiling of 600. Left out because they are marketing devices or conflict with pedit: the mesh gradient, pill buttons, Geist and Geist Mono, negative tracking, the fixed palette and the ink-black primary button (pedit keeps the theme's accent, whose contrast `palette.ts` already guarantees and which embed hosts set through `--pedit-accent`). pedit is not affiliated with Vercel.
