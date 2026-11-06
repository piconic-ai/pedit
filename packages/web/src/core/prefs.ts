/** The part of localStorage the per-browser preferences use; injectable for tests. */
export type Prefs = Pick<Storage, 'getItem' | 'setItem'>
