/**
 * LLM-powered autopick using the team's strategy prompt and custom board.
 * The board is the primary signal; the strategy guides deviations.
 */

import { chatJSON } from './OllamaService';
import { PROSPECT_BY_RANK } from '../data/prospects';
import { DEFAULT_STRATEGY_PROMPTS } from '../data/teamProfiles';

interface AutopickContext {
  availableRanks: number[];
  boardRanks: number[];         // user's custom board (ordered prospect ranks)
  draftedByTeam: Array<{ name: string; pos: string }>;
  rosterPosCounts: Record<string, number>;
  pickInfo: { round: number; roundPick: number; overall: number };
}

interface AutopickResponse {
  pick: string;
}

const SYSTEM_PROMPT = `You are an NFL draft autopick AI. Pick ONE prospect for the team.

Rules:
- Follow the user's board order unless the strategy gives a clear reason to deviate.
- The board represents the user's pre-draft rankings — it is the primary signal.
- Only deviate from the board when the strategy specifically addresses the situation (e.g. "never draft a QB" or "prioritize EDGE in round 1").
- Consider positional need: avoid drafting 3+ players at the same position unless the board/strategy demands it.
- Return ONLY JSON: {"pick":"Exact Prospect Name"}
- The name must EXACTLY match one of the available prospects listed.`;

function buildUserMessage(
  teamAbbr: string,
  strategy: string,
  ctx: AutopickContext,
): string {
  const parts: string[] = [];

  // Pick info
  parts.push(`Team: ${teamAbbr} | Round ${ctx.pickInfo.round}, Pick ${ctx.pickInfo.roundPick} (Overall #${ctx.pickInfo.overall})`);

  // Custom board (top 15 available, in board order)
  const availSet = new Set(ctx.availableRanks);
  const boardAvailable = ctx.boardRanks.filter(r => availSet.has(r)).slice(0, 15);
  if (boardAvailable.length > 0) {
    const boardLines = boardAvailable.map((r, i) => {
      const p = PROSPECT_BY_RANK.get(r);
      return p ? `  ${i + 1}. ${p.name} (${p.pos}, ${p.school})` : `  ${i + 1}. #${r}`;
    });
    parts.push(`\nYour Board (top ${boardAvailable.length} available, in board order):\n${boardLines.join('\n')}`);
  }

  // Strategy
  parts.push(`\nStrategy: ${strategy}`);

  // Already drafted
  if (ctx.draftedByTeam.length > 0) {
    parts.push(`\nAlready drafted: ${ctx.draftedByTeam.map(p => `${p.name} (${p.pos})`).join(', ')}`);
  }

  // Roster position counts
  const posCounts = Object.entries(ctx.rosterPosCounts)
    .filter(([, c]) => c > 0)
    .map(([pos, c]) => `${pos}:${c}`)
    .join(', ');
  if (posCounts) {
    parts.push(`\nRoster positions (draft picks): ${posCounts}`);
  }

  // BPA (top 30 not on the board, for fallback)
  const boardSet = new Set(ctx.boardRanks);
  const bpa = ctx.availableRanks
    .filter(r => !boardSet.has(r))
    .slice(0, 30)
    .map(r => {
      const p = PROSPECT_BY_RANK.get(r);
      return p ? `${p.name} (${p.pos})` : `#${r}`;
    });
  if (bpa.length > 0) {
    parts.push(`\nBPA (not on board): ${bpa.join(', ')}`);
  }

  return parts.join('\n');
}

/**
 * Ask the LLM to pick a prospect for a team.
 * Returns the prospect rank, or undefined if the LLM fails or times out.
 */
export async function smartAutopick(
  teamAbbr: string,
  strategy: string | undefined,
  ctx: AutopickContext,
): Promise<number | undefined> {
  // Resolve strategy: user-set → default team profile → skip
  const strat = strategy ?? DEFAULT_STRATEGY_PROMPTS[teamAbbr];
  if (!strat) return undefined;

  const userMsg = buildUserMessage(teamAbbr, strat, ctx);

  try {
    // 5-second timeout via Promise.race
    const result = await Promise.race([
      chatJSON<AutopickResponse>(SYSTEM_PROMPT, userMsg),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Autopick LLM timeout')), 5000)
      ),
    ]);

    const pickedName = result.pick?.trim();
    if (!pickedName) return undefined;

    // Match against available prospects
    const availSet = new Set(ctx.availableRanks);
    const lower = pickedName.toLowerCase();

    // Exact match
    for (const rank of ctx.availableRanks) {
      const p = PROSPECT_BY_RANK.get(rank);
      if (p && p.name.toLowerCase() === lower && availSet.has(rank)) return rank;
    }

    // Partial match (contains)
    for (const rank of ctx.availableRanks) {
      const p = PROSPECT_BY_RANK.get(rank);
      if (p && p.name.toLowerCase().includes(lower) && availSet.has(rank)) return rank;
    }

    // Reverse partial (picked name contains prospect name)
    for (const rank of ctx.availableRanks) {
      const p = PROSPECT_BY_RANK.get(rank);
      if (p && lower.includes(p.name.toLowerCase()) && availSet.has(rank)) return rank;
    }

    console.warn(`[SmartAutopick] LLM picked "${pickedName}" but no match found in available prospects`);
    return undefined;
  } catch (err) {
    console.warn(`[SmartAutopick] Failed for ${teamAbbr}:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}
