/** The words the element itself renders. The core's own components are not covered yet. */
export interface Labels {
  yourName: string
  join: string
  comments: string
  commentOnly: string
  commentOnlyTitle: string
  readOnly: string
  readOnlyTitle: string
  badLink: string
  unsupportedBrowser: string
  missingRelay: string
  openFailed: string
  /** Read out by the `aria-live` status line, one per `pedit-status`. */
  connecting: string
  live: string
  hostAway: string
  ended: string
}

const en: Labels = {
  yourName: 'Your name',
  join: 'Join',
  comments: 'Comments',
  commentOnly: 'Comment only',
  commentOnlyTitle: 'You can read this file and comment on it.',
  readOnly: 'Read only',
  readOnlyTitle: 'You can read this file.',
  badLink: 'This is not a review link.',
  unsupportedBrowser: 'This browser cannot open the review: it lacks the cryptography it needs.',
  missingRelay: 'This page does not say which relay to use.',
  openFailed: 'The review could not be opened.',
  connecting: 'Connecting',
  live: 'Connected',
  hostAway: 'The host is away',
  ended: 'The review has ended',
}

const ja: Labels = {
  yourName: 'お名前',
  join: '参加',
  comments: 'コメント',
  commentOnly: 'コメントのみ',
  commentOnlyTitle: 'このファイルを読み、コメントできます。',
  readOnly: '閲覧のみ',
  readOnlyTitle: 'このファイルを読めます。',
  badLink: 'レビュー用のリンクではありません。',
  unsupportedBrowser: 'このブラウザには必要な暗号機能がなく、レビューを開けません。',
  missingRelay: 'このページはリレーを指定していません。',
  openFailed: 'レビューを開けませんでした。',
  connecting: '接続中',
  live: '接続しました',
  hostAway: 'ホストが離席中です',
  ended: 'レビューは終了しました',
}

const BUILT_IN: Record<string, Labels> = { en, ja }

/**
 * The labels for the `lang` and `labels` attributes: the language's strings (`en`
 * when it is missing or unknown; a region like `ja-JP` counts as `ja`), with the
 * string values of the `labels` JSON object laid over them. Invalid JSON is ignored.
 */
export function resolveLabels(lang: string | null, json: string | null): Labels {
  const code = (lang ?? '').trim().toLowerCase().split('-')[0] ?? ''
  const base = Object.hasOwn(BUILT_IN, code) ? (BUILT_IN[code] as Labels) : en
  const out = { ...base }
  if (json === null || json.trim() === '') return out
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    console.warn('<pedit-review>: the labels attribute is not valid JSON; ignored.')
    return out
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn('<pedit-review>: the labels attribute is not a JSON object; ignored.')
    return out
  }
  for (const key of Object.keys(en) as (keyof Labels)[]) {
    const own = parsed as Record<string, unknown>
    if (Object.hasOwn(own, key) && typeof own[key] === 'string') out[key] = own[key] as string
  }
  return out
}
