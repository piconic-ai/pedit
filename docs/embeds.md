# Embeds in the preview

A URL on a line of its own in a Markdown document can show a player, or the
text of a source file, in the preview. This page lists what pedit embeds, how
to size an embed, what it means for privacy, and how a self-hosted relay adds,
drops or writes providers.

- [Using embeds](#using-embeds)
- [Supported providers](#supported-providers)
- [Sizes](#sizes)
- [Source files on GitHub](#source-files-on-github)
- [Privacy](#privacy)
- [Customizing the providers](#customizing-the-providers)

## Using embeds

Paste the link on a line of its own:

```
Here is the demo:

https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

The preview shows a placeholder naming the site it would load from, such as
"Load from www.youtube-nocookie.com", with the original link. The player loads
only when someone clicks it, or presses Enter or Space on it, so nobody in the
room contacts a third party just because a URL was written in the file.

Ticking "Always load {name}" next to the placeholder loads that provider's
embeds right away from then on, in your browser only. Settings lists the
providers you chose and can forget each.

A link inside a sentence, or written as `[text](url)`, stays a link. So does a
URL no provider takes.

A pasted share link and the provider's own player link both work. The preview
rebuilds the player URL from the parts it can check, such as the video id and a
start time, and drops the rest of the query (`?si=…`, `?autoplay=1`, and so on).

## Supported providers

These are built into the public relay, in the order the preview tries them:

| Id | Name | Takes | Default box |
| --- | --- | --- | --- |
| `youtube` | YouTube | videos, shorts and live streams, played from `youtube-nocookie.com`, with a start time (`t=` or `start=`) | 16:9 (shorts 9:16) |
| `vimeo` | Vimeo | videos, unlisted ones with their hash | 16:9 |
| `loom` | Loom | shared videos, with a start time (`t=`) | 16:9 |
| `figma` | Figma | designs, boards, slides, decks and prototypes, with `node-id` | 4:3 |
| `codepen` | CodePen | pens (`codepen.io/{user}/pen/{id}`) and team pens (`codepen.io/team/{team}/pen/{id}`) | 4:3 |
| `stackblitz` | StackBlitz | projects and GitHub repositories | 4:3 |
| `observable` | Observable | notebooks, or some of their cells | 4:3 |
| `spotify` | Spotify | tracks, albums, playlists, artists, episodes and shows | 152 px high |
| `soundcloud` | SoundCloud | the player URL Share > Embed gives, for a track or playlist | 166 px high |
| `miro` | Miro | boards | 4:3 |
| `github` | GitHub | public source files, or some of their lines, shown as text | as tall as its lines, up to 60% of the window |

A site can still refuse to be shown in a frame. CodePen sometimes answers a
browser that has not visited it with a "verify you are human" check, which
cannot run inside the preview, so the player stays blank. Open the pen in a tab
once, pass the check, and load the embed again.

## Sizes

A player's URL may end with its size. The size stays in the preview and never
reaches the site:

```
https://youtu.be/dQw4w9WgXcQ#width=560&height=420      4:3, at most 560 px wide
https://vimeo.com/76979871#width=100%&height=480       as wide as the preview, 480 px high
https://youtu.be/dQw4w9WgXcQ#width=560                 the provider's ratio, at most 560 px wide
https://youtu.be/dQw4w9WgXcQ#height=400                the provider's ratio, 400 px high
```

Sizes are whole pixels from 100 to 4000 (a width may also be `100%`). A box
keeps between 4:1 and 1:2, and at most 80% of the window's height; a size
outside that is clamped to it. Without a size, or with any other fragment, the
player takes its provider's default box.

GitHub source files do not take a size: their fragment selects lines instead.

## Source files on GitHub

```
https://github.com/piconic-ai/pedit/blob/main/packages/protocol/src/embeds/loom.ts#L5-L18
```

The placeholder says "Load from raw.githubusercontent.com". Once someone clicks
it, or ticked "Always load GitHub", the browser fetches
`https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` itself. A
fragment such as `#L10` or `#L10-L20` shows just those lines, numbered as in the
file; without one, the whole file is shown.

- Only public files can be shown.
- The text is shown as text, never run or rendered as markup.
- It is shown up to 1 MB and 5000 lines. A file that is not text, too large,
  or unreachable shows a short message, the link and "Try again".
- A link to a commit (`/blob/<sha>/…`) keeps showing the same text after the
  file changes.

## Privacy

- Before a click, or "Always load", the embed's site is not contacted.
- Once loaded, a player runs its own scripts and can set its own cookies, like
  on any page that embeds it. It gets only the relay's origin as `Referer`,
  never the room or its key.
- A GitHub file is fetched without cookies or a `Referer`. GitHub sees your IP
  address and which file, but not the room or its key. The relay sees nothing
  of it.
- "Always load" is stored in your browser only, as the provider's id (such as
  `youtube`) and no URL. It is never sent to the relay.

Click-to-load is for privacy, not a sandbox. What keeps a player away from the
editor is the page's Content-Security-Policy and the frame's sandbox; see
[security design](security-design.md) and [the public relay](public-relay.md).

## Customizing the providers

A self-hosted relay chooses its providers when it is built. Each provider is
one file in `packages/protocol/src/embeds/`, and
`packages/protocol/src/embeds/index.ts` lists the ones the relay uses:

```ts
export default {
  youtube,
  vimeo,
  // …
  github,
} satisfies Providers
```

- **To drop a provider:** remove its line from `index.ts` and its file (and its
  `<id>.test.ts`).
- **To add one:** write `<id>.ts` next to the others with `defineProvider`, and
  add its line to `index.ts`. The id is the key in `index.ts`.
- **To change one:** edit its file.

Then build and deploy as usual ([self-hosting](self-hosting.md)). `pnpm test`
checks that every file is listed and that no two providers overlap.

### A player provider

```ts
import { defineProvider, onHost } from './define.ts'

export default defineProvider({
  name: 'Example', // the name people see, and the frame's title
  frames: ['https://embed.example.com/player/'], // where its players live
  size: { ratio: '16/9' }, // or { height: 152 }, or a function of the URL
  // The player URL for a pasted URL, rebuilt from the parts it checked, or
  // null. Without it, only URLs already under `frames` are framed, as they are.
  embed(url) {
    const id = /^\/(?:v|player)\/(\d{1,20})$/.exec(url.pathname)?.[1]
    if (!id || !onHost(url, 'example.com', 'embed.example.com')) return null
    return `https://embed.example.com/player/${id}`
  },
  sandbox: ['allow-forms'], // on top of allow-scripts allow-same-origin allow-popups
  allow: ['fullscreen'], // permissions policy features
})
```

### A text provider

A provider can show a file's text instead of a player: it names `fetches`,
where its files live, in place of `frames`, and `snippet()` in place of
`embed()`, and has no `size`, `sandbox` or `allow`. GitHub's (`github.ts`) is
one:

```ts
export default defineProvider({
  name: 'GitHub',
  fetches: ['https://raw.githubusercontent.com/'], // into connect-src
  // The file to fetch for a pasted URL, and the lines to show, or null.
  snippet(url) {
    // https://github.com/{owner}/{repo}/blob/{ref}/{path}#L10-L20 becomes
    // { src: 'https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}', lines: [10, 20] }
  },
})
```

The preview fetches only after a click or "Always load", without credentials or
a referrer, for at most 10 seconds and 1 MB, and shows at most 5000 lines, as
text only.

### Rules every provider follows

- **Content-Security-Policy:** every frame prefix goes into the page's
  `frame-src`, and every fetch prefix into `connect-src`. The preview loads only
  URLs under the prefixes of the provider that built them.
- **What a provider may not have:** the types refuse it, and the relay checks
  the same again at run time. A provider that fails is left out and logged.
  This covers:
  - prefixes that are not `https://…/`
  - `allow-top-navigation`, `allow-downloads` or `allow-popups-to-escape-sandbox`
  - frames or fetches that would cover the relay's own origin, where the
    embed could read the page
- **Take only what you can check:** `embed()` and `snippet()` get every URL
  someone writes on a line of its own. They should take only what they can
  check, and rebuild the URL from those parts rather than pass it on.
  - `onHost` compares the host exactly, and refuses user-info, a port or an
    encoded `/`, `\` or `.` in the path.
- **Fixed point:** given a URL it built, `embed()` (or `snippet()`) must return
  the same URL. The preview loads only URLs the provider would build itself,
  which lets a provider's prefixes be wider than its players: CodePen's cover
  all of `https://codepen.io/`.
- **Tests:** put the provider's tests next to it, as `<id>.test.ts`. Cover the
  URLs it takes and what it makes of them, and the ones it leaves alone, such
  as look-alike hosts.
- **"Always load" ids:** browsers remember "Always load" by the provider's id,
  the key in `index.ts`. Renaming a key, or dropping a provider, forgets that
  choice in every browser, so people are asked again.
