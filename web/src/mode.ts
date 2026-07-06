// Draft mode reported by the server (college draft vs NFL redraft).
// Set once when DraftRoom fetches state; components re-render on that fetch's
// setState, so reading it via these helpers stays in sync.
export type DraftMode = 'college' | 'redraft';

let mode: DraftMode = 'college';

export function setDraftMode(m: DraftMode | undefined) {
  mode = m === 'redraft' ? 'redraft' : 'college';
}

export function isRedraft(): boolean {
  return mode === 'redraft';
}

/** Column header for Prospect.school — the player's school or NFL team. */
export function schoolLabel(): string {
  return mode === 'redraft' ? 'NFL Team' : 'School';
}
