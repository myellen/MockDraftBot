import { Prospect } from '../engine/types';

// Redraft player pool template — copy to prospects.redraft.ts, or better,
// generate it: npm run gen-redraft (scripts/generate-redraft-dataset.ts).
//
// Rules the engine relies on:
// - rank is the ID AND the value ordering (rank 1 = best redraft asset; BPA = lowest rank)
// - school = the player's current NFL team (full name, e.g. 'Buffalo Bills')
// - pos uses the same vocabulary as the college pool: QB, RB, WR, TE, OT, OG, C,
//   EDGE, DE, DT, LB, CB, S, K, P, LS
// - names must be unique; disambiguate duplicates with a [ABBR] suffix
export const REDRAFT_PROSPECTS: Prospect[] = [
  { rank: 1, name: 'Player One',   pos: 'QB',   school: 'Team A' },
  { rank: 2, name: 'Player Two',   pos: 'WR',   school: 'Team B' },
  { rank: 3, name: 'Player Three', pos: 'EDGE', school: 'Team C' },
  // ... continue for the full pool (recommended 400-600)
];
