/**
 * GM relationship and trade compatibility data for AIGMService heuristic scoring.
 *
 * Integration: import into AIGMService.ts and add these factors to scoreGMForTrade().
 *
 * Sourced from the LLM Wiki: GM Mentor Tree, GM Trade Style Taxonomy,
 * and 32 GM wiki pages documenting real-world relationships and trade patterns.
 */

/**
 * GM-to-GM relationship strength.
 * Key: "TEAM1-TEAM2" (alphabetical order), Value: bonus points (0-10).
 * Based on shared front-office history, mentor-mentee relationships, and documented trade partnerships.
 *
 * Usage in scoreGMForTrade():
 *   const key = [teamAbbr, onClockTeam].sort().join('-');
 *   score += GM_RELATIONSHIPS[key] ?? 0;
 */
export const GM_RELATIONSHIPS: Record<string, number> = {
  // Strong relationships (8-10 pts) — direct mentor-mentee
  'BUF-NYG': 8,   // Beane trained Schoen directly
  'BUF-CAR': 8,   // Beane trained Morgan directly
  'BAL-LAC': 8,   // DeCosta trained Hortiz
  'KC-TEN': 7,    // Veach trained Borgonzi
  'JAX-LAR': 7,   // Snead mentored Gladstone

  // Moderate relationships (4-7 pts) — shared front-office tenure
  'GB-MIA': 6,    // Sullivan spent 22 years with Packers alongside Gutekunst
  'MIA-SEA': 5,   // Sullivan worked with Schneider in Green Bay
  'MIA-NE': 5,    // Sullivan worked with Eliot Wolf in Green Bay
  'MIA-NYJ': 5,   // Sullivan worked with Mougey in Green Bay
  'ATL-BAL': 5,   // Cunningham worked under DeCosta in Baltimore
  'ATL-PHI': 5,   // Cunningham worked under Roseman in Philadelphia
  'ATL-CHI': 5,   // Cunningham worked under Poles in Chicago
  'CAR-NYG': 4,   // Schoen and Morgan share Bills pipeline
  'BAL-CLE': 4,   // Berry and DeCosta from same analytics circle
  'DEN-MIN': 4,   // Paton and Brzezinski both in Vikings org history

  // Light connections (2-3 pts) — cross-pollination across coaching/GM trees
  'NE-SEA': 3,    // Wolf and Schneider share Green Bay roots
  'GB-NYJ': 3,    // Gutekunst and Mougey overlapped in Green Bay
  'GB-SEA': 3,    // Gutekunst and Schneider share Packers scouting lineage
  'KC-LAC': 2,    // AFC West rivals but Veach and Hortiz in same conference circles
  'BAL-PIT': 2,   // DeCosta and Khan both from AFC North, mutual respect
  'CHI-NE': 2,    // Poles and Wolf both from Belichick-adjacent pipelines
  'DET-LAR': 2,   // Holmes and Snead both from Rams scouting tree
};

/**
 * Trade direction preference for each team's GM.
 * Positive = prefers trading UP (willing to pay premium to move up)
 * Negative = prefers trading DOWN (wants to accumulate picks)
 * Zero = balanced/opportunistic
 *
 * Usage: When a trade-up GM is below the on-clock pick and a trade-down GM
 * is on the clock (or vice versa), add a compatibility bonus.
 *
 *   const proposerDir = TRADE_DIRECTION[teamAbbr] ?? 0;
 *   const onClockDir = TRADE_DIRECTION[onClockTeam] ?? 0;
 *   // Opposite directions = natural trade partners
 *   if (proposerDir > 0 && onClockDir < 0) score += Math.min(proposerDir + Math.abs(onClockDir), 15);
 *   if (proposerDir < 0 && onClockDir > 0) score += Math.min(Math.abs(proposerDir) + onClockDir, 15);
 */
export const TRADE_DIRECTION: Record<string, number> = {
  // Strong trade-up preference (6-8)
  PHI: 8,   // Roseman — most aggressive trader in NFL, 7 first-round trade-ups
  NYJ: 7,   // Mougey — "everything's on the table", scorched earth rebuild
  NO: 6,    // Loomis — aggressive trade-up tendencies
  PIT: 6,   // Khan — five top-100 picks, projected trade-up candidate
  GB: 6,    // Gutekunst — 8 trade-ups in 13 draft-day trades, but no 1st this year

  // Moderate trade-up (3-5)
  HOU: 4,   // Caserio — aggressive but adapts
  DET: 4,   // Holmes — willing to trade up 20 spots
  LAR: 4,   // Snead — aggressive in both directions
  KC: 3,    // Veach — aggressive with rare early capital this year
  TB: 3,    // Licht — deal-maker, will push for value
  JAX: 3,   // Gladstone — traded up for Hunter

  // Balanced (0)
  NE: 0,    // Wolf — open either direction
  MIA: 0,   // Sullivan — new GM, 7 top-100 picks, could go either way
  WAS: 0,   // Peters — BPA-first, may trade down from 7
  NYG: 0,   // Schoen — could go either way
  CAR: 0,   // Morgan — aggressive but restrained by Tilis
  ATL: 0,   // Cunningham — first-year, establishing identity
  LV: 0,    // Spytek — first-year, has No. 1 pick
  TEN: 0,   // Borgonzi — first-year, building
  MIN: 0,   // Brzezinski — interim, cautious
  SF: 0,    // Lynch — balanced approach

  // Moderate trade-down (-3 to -5)
  BUF: -2,  // Beane — patient, lets value come to him
  DAL: -3,  // Jones/McClay — trade-down mentality recently
  CHI: -3,  // Poles — tends to trade back and accumulate
  CLE: -4,  // Berry — openly embraces trade-back flexibility
  SEA: -4,  // Schneider — 74 trades, prioritizes volume
  DEN: -4,  // Paton — multi-step trade-back sequences
  BAL: -5,  // DeCosta — premier pick accumulator

  // Strong trade-down / conservative (-6 to -8)
  ARI: -5,  // Ossenfort — conservative, draft-and-develop
  CIN: -6,  // Tobin — "don't typically make major moves"
  IND: -6,  // Ballard — draft-and-retain, rarely trades
};

/**
 * NFL divisions for rivalry penalty lookup.
 */
const NFL_DIVISIONS: readonly string[][] = [
  // AFC East
  ['BUF', 'MIA', 'NE', 'NYJ'],
  // AFC North
  ['BAL', 'CIN', 'CLE', 'PIT'],
  // AFC South
  ['HOU', 'IND', 'JAX', 'TEN'],
  // AFC West
  ['DEN', 'KC', 'LV', 'LAC'],
  // NFC East
  ['DAL', 'NYG', 'PHI', 'WAS'],
  // NFC North
  ['CHI', 'DET', 'GB', 'MIN'],
  // NFC South
  ['ATL', 'CAR', 'NO', 'TB'],
  // NFC West
  ['ARI', 'LAR', 'SF', 'SEA'],
] as const;

/** Pre-computed set of divisional pairs for O(1) lookup. */
const DIVISIONAL_PAIRS: ReadonlySet<string> = new Set(
  NFL_DIVISIONS.flatMap((division) => {
    const pairs: string[] = [];
    for (let i = 0; i < division.length; i++) {
      for (let j = i + 1; j < division.length; j++) {
        pairs.push([division[i], division[j]].sort().join('-'));
      }
    }
    return pairs;
  }),
);

/**
 * Divisional rivalry penalty.
 * Teams in the same division rarely trade with each other on draft day.
 * Returns true if two teams are in the same division.
 *
 * Usage: if (areDivisionalRivals(teamAbbr, onClockTeam)) score -= 8;
 */
export function areDivisionalRivals(team1: string, team2: string): boolean {
  const key = [team1, team2].sort().join('-');
  return DIVISIONAL_PAIRS.has(key);
}

/**
 * Integration instructions for AIGMService.ts's scoreGMForTrade() method.
 * Add these after the existing scoring factors:
 *
 * ```typescript
 * import { GM_RELATIONSHIPS, TRADE_DIRECTION, areDivisionalRivals } from '../data/gmRelationships';
 *
 * // In scoreGMForTrade():
 *
 * // 8. GM relationship bonus (0-10 pts)
 * const relKey = [teamAbbr, onClockTeam].sort().join('-');
 * score += GM_RELATIONSHIPS[relKey] ?? 0;
 *
 * // 9. Trade direction compatibility (0-15 pts)
 * const proposerDir = TRADE_DIRECTION[teamAbbr] ?? 0;
 * const onClockDir = TRADE_DIRECTION[onClockTeam] ?? 0;
 * if (proposerDir > 0 && onClockDir < 0) score += Math.min(proposerDir + Math.abs(onClockDir), 15);
 * if (proposerDir < 0 && onClockDir > 0) score += Math.min(Math.abs(proposerDir) + onClockDir, 15);
 *
 * // 10. Divisional rivalry penalty (-8 pts)
 * if (areDivisionalRivals(teamAbbr, onClockTeam)) score -= 8;
 * ```
 */
