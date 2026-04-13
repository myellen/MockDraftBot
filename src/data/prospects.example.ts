import { Prospect } from '../engine/types';

// Replace with your full prospect list sourced from a big board (e.g. DraftTek, PFF, etc.)
// Positions: QB, RB, WR, TE, OT, OG, C, EDGE, DT, DE, LB, CB, S, K, P
export const PROSPECTS: Prospect[] = [
  { rank: 1,   name: 'Player One',         pos: 'QB',   school: 'University A' },
  { rank: 2,   name: 'Player Two',         pos: 'EDGE', school: 'University B' },
  { rank: 3,   name: 'Player Three',       pos: 'RB',   school: 'University C' },
  { rank: 4,   name: 'Player Four',        pos: 'WR',   school: 'University D' },
  { rank: 5,   name: 'Player Five',        pos: 'OT',   school: 'University E' },
  // ... continue for all prospects (recommended 200-500)
];
