// Dataset selector shim — do NOT put roster data in this file.
// Real rosters live in rosters.college.ts (regenerate with scripts/generate-rosters.ts).
// In redraft mode every current player is in the draft pool, so teams start
// with empty rosters; roster/cap/player-trade surfaces all degrade cleanly.
import { DRAFT_MODE } from './draftMode';
import { ROSTERS as COLLEGE_ROSTERS } from './rosters.college';
import type { RosterPlayer } from './rosters.college';

export type { RosterPlayer } from './rosters.college';

export const ROSTERS: Record<string, RosterPlayer[]> =
  DRAFT_MODE === 'redraft' ? {} : COLLEGE_ROSTERS;
