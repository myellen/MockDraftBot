// NFL Draft — Complete pick order
// Copy to draftOrder.college.ts. Source your draft order from ESPN, NFL.com, Tankathon, etc.
// currentTeam = team currently holding the pick after all known trades

export interface DraftPickEntry {
  overall: number;
  round: number;
  roundPick: number;
  originalTeam: string;  // team assigned to this slot by draft position / comp award
  currentTeam: string;   // team that actually holds the pick
}

export const DRAFT_ORDER: DraftPickEntry[] = [
  // ── Round 1 ─────────────────────────────────────────────────────────────
  { overall:  1, round: 1, roundPick:  1, originalTeam: 'LV',  currentTeam: 'LV'  },
  { overall:  2, round: 1, roundPick:  2, originalTeam: 'NYJ', currentTeam: 'NYJ' },
  { overall:  3, round: 1, roundPick:  3, originalTeam: 'ARI', currentTeam: 'ARI' },
  // ... continue for all picks (typically 224 standard + compensatory)
  // Use originalTeam for the slot's assigned team, currentTeam for the holder after trades
  // Example of a traded pick:
  // { overall: 13, round: 1, roundPick: 13, originalTeam: 'ATL', currentTeam: 'LAR' },
];
