// What an embed provider is. Each provider is one file next to this one, written
// with defineProvider, and index.ts lists the ones this relay shows: adding or
// removing a provider is adding or removing a file and its line there.
// A provider either frames players (frames) or fetches text files (fetches).
// The types only hold at compile time; csp.ts checks every provider again when
// the policy is built and when the preview frames or fetches a URL.

/** Sandbox tokens every provider's frames get. */
export const SANDBOX_BASE = ['allow-scripts', 'allow-same-origin', 'allow-popups'] as const

/**
 * Sandbox tokens a provider may add. Never allow-top-navigation*, which could take
 * the editor tab away, nor allow-popups-to-escape-sandbox: an unsandboxed popup
 * could do the same through `opener.top`. Nor allow-downloads.
 */
export const SANDBOX_EXTRAS = [
  'allow-forms',
  'allow-modals',
  'allow-orientation-lock',
  'allow-pointer-lock',
  'allow-presentation',
  'allow-storage-access-by-user-activation',
] as const

export type SandboxExtra = (typeof SANDBOX_EXTRAS)[number]

/**
 * Permissions policy features a provider may ask for. Not clipboard-read: the
 * clipboard may hold the room's link, key and all.
 */
export const ALLOW_FEATURES = [
  'accelerometer',
  'autoplay',
  'clipboard-write',
  'cross-origin-isolated',
  'encrypted-media',
  'fullscreen',
  'gyroscope',
  'picture-in-picture',
  'web-share',
] as const

export type AllowFeature = (typeof ALLOW_FEATURES)[number]

/** A frame-src prefix: an https origin and a path that ends in '/'. */
export type FrameUrl = `https://${string}/`

/** A connect-src prefix, written like a frame prefix. */
export type FetchUrl = `https://${string}/`

/** A frame's default box: an aspect ratio such as '16/9', or a height in pixels. */
export type Size = { ratio: `${number}/${number}` } | { height: number }

/** The highest line number a snippet may name. */
export const MAX_LINE = 1_000_000

/**
 * A text file the preview fetches and shows as text: its URL, and the lines to
 * show, first and last counted from 1 (the whole file without).
 */
export type Snippet = { src: string; lines?: readonly [number, number] }

/** A provider whose players the preview frames. */
export type FrameProvider = {
  /** The name people see, as in "Always load {name}", and the frame's title. */
  name: string
  /**
   * Where its players live. They go into the policy's frame-src, and the preview
   * frames only URLs under one of them.
   */
  frames: readonly FrameUrl[]
  /** The frame's default box, which may depend on the URL (a YouTube short is tall). */
  size: Size | ((url: URL) => Size)
  /**
   * The player URL for a pasted URL, rebuilt from the parts it checked, or null.
   * Without it, only URLs already under `frames` are framed, as they are.
   * Given a player URL it built, it must return that URL unchanged: the preview
   * frames only player URLs the provider would build itself, so a provider's
   * frames may be wider than its players (CodePen's are all of codepen.io).
   */
  embed?: (url: URL) => string | null
  /** Sandbox tokens on top of SANDBOX_BASE. */
  sandbox?: readonly SandboxExtra[]
  /** Permissions policy features of the frame. */
  allow?: readonly AllowFeature[]
  fetches?: never
  snippet?: never
}

/**
 * A provider whose files the preview fetches and shows as text, never as markup.
 * Nothing it serves runs on the page.
 */
export type FetchProvider = {
  /** The name people see, as in "Always load {name}". */
  name: string
  /**
   * Where its files live. They go into the policy's connect-src, and the preview
   * fetches only URLs under one of them.
   */
  fetches: readonly FetchUrl[]
  /**
   * The file to fetch for a pasted URL, rebuilt from the parts it checked, or
   * null. The src must start with one of `fetches`, and given a src it built
   * (without lines), it must return that src unchanged, as embed() does.
   */
  snippet: (url: URL) => Snippet | null
  frames?: never
  size?: never
  embed?: never
  sandbox?: never
  allow?: never
}

export type Provider = FrameProvider | FetchProvider

/**
 * Whether `provider` is shown by fetching text rather than in a frame. As
 * providerProblem decides: `fetches: undefined` is no fetch provider.
 */
export function isFetchProvider(provider: Provider): provider is FetchProvider {
  return provider.fetches !== undefined
}

/** The providers a relay shows, by id. The id is what "Always load" remembers. */
export type Providers = Readonly<Record<string, Provider>>

/** Declares a provider; the type rejects anything a provider may not have. */
export function defineProvider(provider: FrameProvider): FrameProvider
export function defineProvider(provider: FetchProvider): FetchProvider
export function defineProvider(provider: Provider): Provider {
  return provider
}

/** The sandbox attribute of a provider's frames. */
export function sandboxOf(provider: Pick<FrameProvider, 'sandbox'>): string {
  return [...SANDBOX_BASE, ...(provider.sandbox ?? [])].join(' ')
}

/** The allow attribute of a provider's frames ('' for none). */
export function allowOf(provider: Pick<FrameProvider, 'allow'>): string {
  return (provider.allow ?? []).join('; ')
}

// An encoded slash, backslash or dot could become a different path on the provider's server.
const ENCODED_SEPARATOR = /%(2f|5c|2e)/i

/**
 * Whether `url` is on one of `hosts`, compared exactly, and could be one of its
 * links: no user-info, port or encoded separator in the path, which no
 * provider's links carry. For an embed() to check a pasted URL with.
 */
export function onHost(url: URL, ...hosts: readonly string[]): boolean {
  if (url.username || url.password || url.port || ENCODED_SEPARATOR.test(url.pathname)) return false
  return hosts.includes(url.hostname)
}
