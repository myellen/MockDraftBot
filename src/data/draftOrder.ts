// Dataset selector shim — do NOT put draft-order data in this file.
// The real order lives in draftOrder.college.ts (see draftOrder.example.ts).
//
// Redraft mode reuses the same pick slots but as a clean slate: every team
// holds its own picks (real-life pick trades belong to the college-draft
// universe) and there are no pre-existing future-pick trades.
import { DRAFT_MODE } from './draftMode';
import {
  DRAFT_ORDER as COLLEGE_DRAFT_ORDER,
  FUTURE_PICK_TRADES as COLLEGE_FUTURE_PICK_TRADES,
} from './draftOrder.college';
import type { DraftPickEntry } from './draftOrder.college';

export type { DraftPickEntry } from './draftOrder.college';

export const DRAFT_ORDER: DraftPickEntry[] =
  DRAFT_MODE === 'redraft'
    ? COLLEGE_DRAFT_ORDER.map(p => ({ ...p, currentTeam: p.originalTeam }))
    : COLLEGE_DRAFT_ORDER;

export const FUTURE_PICK_TRADES: {
  year: number; round: number; originalTeam: string; currentTeam: string;
}[] = DRAFT_MODE === 'redraft' ? [] : COLLEGE_FUTURE_PICK_TRADES;
