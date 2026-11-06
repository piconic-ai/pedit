// Kept apart from csp.ts, which pulls in the embed providers: the review
// component's `reviewCSP` needs this list alone.

/** Hosts an avatar may come from. Awareness state is written by anyone with the link. */
export const AVATAR_HOSTS = [
  'gravatar.com',
  'www.gravatar.com',
  'secure.gravatar.com',
  'avatars.githubusercontent.com',
  'lh3.googleusercontent.com',
] as const
