/**
 * Composite Draft Scoring Engine
 *
 * Scores every available prospect on four factors and picks the highest composite score.
 * Replaces the old linear board walk so autopick behaves like an actual GM making tradeoffs.
 *
 * compositeScore = boardScore × positionalValue × needUrgency × scarcityPremium
 */

import { Prospect, CompletedPick, PickSlot, TeamNeeds } from './types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScorerConfig {
  /** Steepness of board rank dropoff (default 1.5) */
  rankDecayExponent: number;
  /** How aggressively to penalize position duplication (default 1.0) */
  positionalDecayStrength: number;
  /** How much to chase scarce positions (default 1.0) */
  scarcityWeight: number;
  /** How much to favor declared needs over pure BPA (default 1.0) */
  needWeight: number;
  /** Max picks at one position before value floors (default 3) */
  positionHardCap: number;
}

export interface ScorerContext {
  /** Prospects still on the board */
  availableProspects: Prospect[];
  /** GM's custom board order (prospect ranks), if submitted */
  customBoard: number[];
  /** GM's position priority list, if set */
  positionPriority: string[];
  /** Picks this team has already made */
  teamPicks: CompletedPick[];
  /** Current NFL roster for this team */
  roster: Array<{ name: string; pos: string }>;
  /** Remaining pick slots this team has in the draft */
  remainingPicks: PickSlot[];
  /** GM-declared needs, or auto-detected */
  needs: TeamNeeds;
  /** Optional config overrides */
  config?: Partial<ScorerConfig>;
}

export interface ScoredProspect {
  prospect: Prospect;
  boardScore: number;
  positionalValue: number;
  needUrgency: number;
  scarcityPremium: number;
  compositeScore: number;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ScorerConfig = {
  rankDecayExponent: 1.5,
  positionalDecayStrength: 1.0,
  scarcityWeight: 1.0,
  needWeight: 1.0,
  positionHardCap: 3,
};

// ─── Position Groups ────────────────────────────────────────────────────────
// Related positions share diminishing returns at partial weight.

const POSITION_GROUPS: Record<string, { group: string; weight: number }> = {
  OT:   { group: 'OL', weight: 0.6 },
  OG:   { group: 'OL', weight: 0.6 },
  C:    { group: 'OL', weight: 0.6 },
  EDGE: { group: 'PASS_RUSH', weight: 0.4 },
  DE:   { group: 'PASS_RUSH', weight: 0.4 },
  DT:   { group: 'IDL', weight: 0.3 },
  CB:   { group: 'DB', weight: 0.3 },
  S:    { group: 'DB', weight: 0.3 },
  LB:   { group: 'LB', weight: 0.0 },
  WR:   { group: 'WR', weight: 0.0 },
  TE:   { group: 'TE', weight: 0.0 },
  RB:   { group: 'RB', weight: 0.0 },
  QB:   { group: 'QB', weight: 0.0 },
  K:    { group: 'ST', weight: 0.5 },
  P:    { group: 'ST', weight: 0.5 },
  LS:   { group: 'ST', weight: 0.5 },
};

// ─── Roster Position Normalization ──────────────────────────────────────────
// ESPN rosters use labels like OLB, ILB, FS, SS, NT, etc.
// Map them to our prospect position codes.

const POSITION_NORMALIZE: Record<string, string> = {
  // Defense
  OLB: 'EDGE',
  ILB: 'LB',
  MLB: 'LB',
  FS:  'S',
  SS:  'S',
  NT:  'DT',
  // Offense
  FB:  'RB',
  G:   'OG',
  T:   'OT',
  // Already correct but be explicit
  QB:   'QB',
  RB:   'RB',
  WR:   'WR',
  TE:   'TE',
  OT:   'OT',
  OG:   'OG',
  C:    'C',
  EDGE: 'EDGE',
  DE:   'DE',
  DT:   'DT',
  LB:   'LB',
  CB:   'CB',
  S:    'S',
  K:    'K',
  P:    'P',
  LS:   'LS',
};

/** Normalize an ESPN/roster position label to our prospect position codes */
function normalizePosition(pos: string): string {
  return POSITION_NORMALIZE[pos.toUpperCase()] ?? pos.toUpperCase();
}

// ─── Ideal Roster Depth Targets ─────────────────────────────────────────────
// Used for auto-detecting needs when GM hasn't set them manually.

const IDEAL_DEPTH: Record<string, number> = {
  QB:   2,
  RB:   3,
  WR:   5,
  TE:   3,
  OT:   4,
  OG:   4,
  C:    2,
  EDGE: 4,
  DE:   3,
  DT:   4,
  LB:   4,
  CB:   5,
  S:    4,
  K:    1,
  P:    1,
  LS:   1,
};

// ─── Core Scoring Functions ─────────────────────────────────────────────────

/**
 * Board Score (0–1): Normalized rank position with exponential decay.
 * If the GM has a custom board, uses position on that board.
 * Otherwise uses the prospect's overall rank.
 */
function computeBoardScore(
  prospect: Prospect,
  customBoard: number[],
  totalAvailable: number,
  config: ScorerConfig,
): number {
  let position: number;
  let total: number;

  if (customBoard.length > 0) {
    const boardIndex = customBoard.indexOf(prospect.rank);
    if (boardIndex === -1) {
      // Not on the GM's board — use overall rank but with a penalty
      // Place them after all board players
      position = customBoard.length + prospect.rank;
      total = customBoard.length + totalAvailable;
    } else {
      position = boardIndex;
      total = customBoard.length;
    }
  } else {
    // No custom board — use raw rank among available
    position = prospect.rank;
    total = totalAvailable;
  }

  // Normalize to 0–1 with exponential decay
  const normalized = position / Math.max(total, 1);
  return Math.max(0.01, Math.pow(1 - normalized, config.rankDecayExponent));
}

/**
 * Positional Value (0.1–1.0): Diminishing returns per position.
 * First pick at a position = 1.0, each subsequent pick halves the value.
 * Position groups share decay at partial weight.
 */
function computePositionalValue(
  prospect: Prospect,
  teamPicks: CompletedPick[],
  roster: Array<{ name: string; pos: string }>,
  config: ScorerConfig,
): number {
  const pos = prospect.pos;

  // Count exact position picks already made
  const exactPicked = teamPicks.filter(p => p.pos === pos).length;

  // Check hard cap
  if (exactPicked >= config.positionHardCap) return 0.1;

  // Count group overlap (partial diminishing)
  const groupInfo = POSITION_GROUPS[pos];
  let groupOverlap = 0;
  if (groupInfo && groupInfo.weight > 0) {
    for (const pick of teamPicks) {
      if (pick.pos === pos) continue; // already counted in exactPicked
      const pickGroup = POSITION_GROUPS[pick.pos];
      if (pickGroup && pickGroup.group === groupInfo.group) {
        groupOverlap += groupInfo.weight;
      }
    }
  }

  const effectivePicked = exactPicked + groupOverlap;
  const decay = Math.pow(0.5, effectivePicked * config.positionalDecayStrength);
  return Math.max(0.1, decay);
}

/**
 * Need Urgency (0.3–2.5): Combines declared need tiers with dynamic pressure.
 * Base: primary=1.5×, secondary=1.2×, depth=1.0×, none=0.7×
 * Then adjusted by ratio of unfilled needs to remaining picks.
 */
function computeNeedUrgency(
  prospect: Prospect,
  needs: TeamNeeds,
  teamPicks: CompletedPick[],
  remainingPicks: number,
  config: ScorerConfig,
): number {
  const pos = prospect.pos;

  // Determine base multiplier from need tier
  let baseMult: number;
  if (needs.primary.includes(pos)) {
    baseMult = 1.5;
  } else if (needs.secondary.includes(pos)) {
    baseMult = 1.2;
  } else if (needs.depth.includes(pos)) {
    baseMult = 1.0;
  } else {
    baseMult = 0.7;
  }

  // Count unfilled needs (needs where we haven't drafted that position yet)
  const pickedPositions = new Set(teamPicks.map(p => p.pos));
  const unfilledPrimary = needs.primary.filter(p => !pickedPositions.has(p)).length;
  const unfilledSecondary = needs.secondary.filter(p => !pickedPositions.has(p)).length;
  // Weight: primary needs count more than secondary
  const totalUnfilled = unfilledPrimary * 1.5 + unfilledSecondary;

  // Dynamic pressure: more unfilled needs + fewer picks = more urgency
  if (remainingPicks > 0 && totalUnfilled > 0) {
    const pressure = totalUnfilled / remainingPicks;
    // If this is a need position, boost it more under pressure
    if (needs.primary.includes(pos) || needs.secondary.includes(pos)) {
      baseMult += pressure * 0.5 * config.needWeight;
    }
  }

  return Math.max(0.3, Math.min(2.5, baseMult));
}

/**
 * Scarcity Premium (1.0–2.0): If a position has fewer available prospects
 * than its expected share, boost its value.
 */
function computeScarcityPremium(
  prospect: Prospect,
  availableProspects: Prospect[],
  config: ScorerConfig,
): number {
  const pos = prospect.pos;
  const totalAvailable = availableProspects.length;
  if (totalAvailable === 0) return 1.0;

  const posCount = availableProspects.filter(p => p.pos === pos).length;
  const posShare = posCount / totalAvailable;

  // Expected share is roughly uniform across ~16 positions ≈ 6.25%
  const expectedShare = 0.0625;

  if (posShare >= expectedShare) return 1.0;

  // Scarce: boost proportionally to how scarce
  const scarcityRatio = expectedShare / Math.max(posShare, 0.005);
  const premium = 1.0 + (scarcityRatio - 1.0) * 0.3 * config.scarcityWeight;

  return Math.min(2.0, premium);
}

// ─── Main Scoring ───────────────────────────────────────────────────────────

/**
 * Score all available prospects and return them sorted best-first.
 */
export function scoreAllProspects(ctx: ScorerContext): ScoredProspect[] {
  const config = { ...DEFAULT_CONFIG, ...ctx.config };
  const totalAvailable = ctx.availableProspects.length;
  const remainingPickCount = ctx.remainingPicks.length;

  // Normalize roster positions for downstream counting
  const normalizedRoster = ctx.roster.map(r => ({
    name: r.name,
    pos: normalizePosition(r.pos),
  }));

  const scored: ScoredProspect[] = [];

  for (const prospect of ctx.availableProspects) {
    const boardScore = computeBoardScore(prospect, ctx.customBoard, totalAvailable, config);
    const positionalValue = computePositionalValue(prospect, ctx.teamPicks, normalizedRoster, config);
    const needUrgency = computeNeedUrgency(prospect, ctx.needs, ctx.teamPicks, remainingPickCount, config);
    const scarcityPremium = computeScarcityPremium(prospect, ctx.availableProspects, config);

    const compositeScore = boardScore * positionalValue * needUrgency * scarcityPremium;

    scored.push({
      prospect,
      boardScore,
      positionalValue,
      needUrgency,
      scarcityPremium,
      compositeScore,
    });
  }

  scored.sort((a, b) => b.compositeScore - a.compositeScore);
  return scored;
}

/**
 * Get the rank of the best pick for a team.
 */
export function getBestPick(ctx: ScorerContext): number | undefined {
  const scored = scoreAllProspects(ctx);
  return scored.length > 0 ? scored[0].prospect.rank : undefined;
}

/**
 * Get the top N picks with full breakdowns (for /board explain).
 */
export function getTopPicks(ctx: ScorerContext, n: number): ScoredProspect[] {
  return scoreAllProspects(ctx).slice(0, n);
}

/**
 * Auto-detect needs from roster depth.
 * Counts roster players by position, compares to ideal depth targets,
 * and classifies gaps as primary (deficit ≥ 3), secondary (deficit ≥ 2), or depth (deficit = 1).
 */
export function autoDetectNeeds(
  positionCounts: Record<string, number>,
): TeamNeeds {
  const needs: TeamNeeds = { primary: [], secondary: [], depth: [] };

  for (const [pos, ideal] of Object.entries(IDEAL_DEPTH)) {
    const current = positionCounts[pos] ?? 0;
    const deficit = ideal - current;

    if (deficit >= 3) {
      needs.primary.push(pos);
    } else if (deficit >= 2) {
      needs.secondary.push(pos);
    } else if (deficit >= 1) {
      needs.depth.push(pos);
    }
  }

  return needs;
}

/**
 * Count roster + drafted players by normalized position.
 */
export function countPositions(
  roster: Array<{ name: string; pos: string }>,
  teamPicks: CompletedPick[],
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const player of roster) {
    const pos = normalizePosition(player.pos);
    counts[pos] = (counts[pos] ?? 0) + 1;
  }

  for (const pick of teamPicks) {
    const pos = pick.pos;
    counts[pos] = (counts[pos] ?? 0) + 1;
  }

  return counts;
}

/**
 * Format a scored prospect for debug logging.
 */
export function formatScoredPick(sp: ScoredProspect): string {
  const p = sp.prospect;
  return `#${p.rank} ${p.name} (${p.pos}) — ` +
    `Board: ${sp.boardScore.toFixed(3)} × ` +
    `PosVal: ${sp.positionalValue.toFixed(3)} × ` +
    `Need: ${sp.needUrgency.toFixed(3)} × ` +
    `Scarcity: ${sp.scarcityPremium.toFixed(3)} = ` +
    `${sp.compositeScore.toFixed(4)}`;
}
