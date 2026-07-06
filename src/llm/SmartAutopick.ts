/**
 * LLM-powered autopick using the team's strategy prompt and custom board.
 * The board is the primary signal; the strategy guides deviations.
 */

import { chatJSON, LLMAbortError, getContextTier } from './OllamaService';
import { DRAFT_MODE } from '../data/draftMode';
import { PROSPECT_BY_RANK } from '../data/prospects';
import { DEFAULT_STRATEGY_PROMPTS } from '../data/teamProfiles';
import { lookupProspect } from '../data/beastScouting';
import { ROSTERS } from '../data/rosters';
import { TEAM_CAP } from '../data/capData';

interface AutopickContext {
  availableRanks: number[];
  boardRanks: number[];         // user's custom board (ordered prospect ranks)
  draftedByTeam: Array<{ name: string; pos: string }>;
  rosterPosCounts: Record<string, number>;
  pickInfo: { round: number; roundPick: number; overall: number };
  researchContext?: string;  // pre-pick scouting analysis from board-ai pipeline
}

interface AutopickResponse {
  pick: string;
}

const SYSTEM_PROMPT = DRAFT_MODE === 'redraft'
  ? `You are an NFL redraft autopick AI. The whole league is being re-drafted: every current NFL player is in the pool and all rosters start empty. Pick ONE player for the team.

Rules:
- Follow the user's board order unless the strategy gives a clear reason to deviate.
- The board represents the user's pre-draft rankings — it is the primary signal.
- Only deviate from the board when the strategy specifically addresses the situation (e.g. "never draft a QB" or "prioritize EDGE in round 1").
- Consider positional need: you are building a full roster from scratch — avoid drafting 3+ players at the same position unless the board/strategy demands it.
- Return ONLY JSON: {"pick":"Exact Player Name"}
- The name must EXACTLY match one of the available players listed.`
  : `You are an NFL draft autopick AI. Pick ONE prospect for the team.

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

  if (ctx.researchContext) {
    parts.push(`\nPre-pick scouting research:\n${ctx.researchContext}`);
  }

  // ── Rich context (Anthropic / large context window) ──
  if (getContextTier() === 'rich') {
    // Scouting reports for top board prospects
    const scoutTargets = boardAvailable.slice(0, 8);
    if (scoutTargets.length > 0) {
      const reports: string[] = [];
      for (const rank of scoutTargets) {
        const p = PROSPECT_BY_RANK.get(rank);
        if (!p) continue;
        try {
          const raw = JSON.parse(lookupProspect(p.name));
          if (raw.error) continue;
          const lines = [`${raw.name} (${raw.pos}, ${raw.school}) — Grade: ${raw.grade}`];
          if (raw.summary) lines.push(`  Summary: ${raw.summary}`);
          if (raw.strengths?.length) lines.push(`  Strengths: ${raw.strengths.join('; ')}`);
          if (raw.weaknesses?.length) lines.push(`  Weaknesses: ${raw.weaknesses.join('; ')}`);
          if (raw.combine) {
            const m = raw.combine;
            const measurables = [m.ht, m.wt && `${m.wt}lbs`, m.forty && `${m.forty}s 40`, m.vert && `${m.vert}" vert`].filter(Boolean);
            if (measurables.length) lines.push(`  Measurables: ${measurables.join(', ')}`);
          }
          reports.push(lines.join('\n'));
        } catch { /* scouting data not available */ }
      }
      if (reports.length > 0) {
        parts.push(`\nScouting Reports:\n${reports.join('\n\n')}`);
      }
    }

    // Roster depth chart by position
    const roster = ROSTERS[teamAbbr];
    if (roster?.length) {
      const byPos = new Map<string, string[]>();
      for (const player of roster) {
        const list = byPos.get(player.pos) ?? [];
        list.push(player.name);
        byPos.set(player.pos, list);
      }
      const depthLines = [...byPos.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([pos, names]) => `  ${pos}: ${names.join(', ')}`);
      parts.push(`\nCurrent Roster Depth:\n${depthLines.join('\n')}`);
    }

    // Cap situation — college-universe contracts don't exist in a redraft
    const cap = DRAFT_MODE === 'redraft' ? undefined : TEAM_CAP[teamAbbr];
    if (cap) {
      parts.push(`\nCap Space: $${(cap.capSpace / 1000).toFixed(1)}M | Dead Money: $${(cap.deadMoney / 1000).toFixed(1)}M`);
    }
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
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<number | undefined> {
  // Resolve strategy: user-set → default team profile → skip
  const strat = strategy ?? DEFAULT_STRATEGY_PROMPTS[teamAbbr];
  if (!strat) return undefined;

  const userMsg = buildUserMessage(teamAbbr, strat, ctx);

  const controller = new AbortController();
  const composed = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;
  const effectiveTimeout = timeoutMs ?? 5000;
  const timer = effectiveTimeout > 0
    ? setTimeout(() => controller.abort(), effectiveTimeout)
    : null;

  try {
    const result = await chatJSON<AutopickResponse>(SYSTEM_PROMPT, userMsg, { signal: composed });

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
    if (err instanceof LLMAbortError) {
      console.log(`[SmartAutopick] Aborted for ${teamAbbr}`);
    } else {
      console.warn(`[SmartAutopick] Failed for ${teamAbbr}:`, err instanceof Error ? err.message : err);
    }
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
