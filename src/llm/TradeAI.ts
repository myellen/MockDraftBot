/**
 * LLM-powered trade decision functions for AI GMs.
 *
 * Three entry points:
 *   evaluateIncomingTrade — accept / decline / counter a proposal
 *   generateTradeIdea     — proactively propose a trade to another team
 *   decideOnClockTrade    — on the clock: pick or trade down?
 *
 * Each wraps a chatJSON call with an 8-second timeout.
 */

import { chatJSON } from './OllamaService';
import { GMProfile } from '../data/gmProfiles';
import { getPickValue, getValueChartPrompt, evaluateTradeValue, type ValueChartType } from '../engine/tradeValue';
import { PROSPECT_BY_RANK } from '../data/prospects';
import { TEAMS } from '../data/teams';
import { TRADE_PLAYERS } from '../data/capData';

// ── Response types ──────────────────────────────────────────────────────────

export interface TradeEvaluation {
  decision: 'accept' | 'decline' | 'counter';
  reasoning: string;
  counterOffer?: {
    offeredOveralls: number[];
    requestedOveralls: number[];
    offeredFuturePicks: string[];
    requestedFuturePicks: string[];
    offeredPlayers?: string[];
    requestedPlayers?: string[];
  };
}

export interface TradeIdea {
  partnerTeam: string;
  offeredOveralls: number[];
  requestedOveralls: number[];
  offeredFuturePicks: string[];
  requestedFuturePicks: string[];
  offeredPlayers: string[];
  requestedPlayers: string[];
  pitch: string;
}

export interface OnClockDecision {
  action: 'pick' | 'trade';
  tradeIdea?: TradeIdea;
}

// ── Shared context ──────────────────────────────────────────────────────────

export interface TradeablePlayer {
  name: string;
  pos: string;
  capHit: number;
  incomingCap: number;
}

export interface TradeAIContext {
  teamAbbr: string;
  teamPicks: Array<{ overall: number; round: number }>;
  teamFuturePicks: Array<{ id: string; year: number; round: number }>;
  availableRanks: number[];
  draftedByTeam: Array<{ name: string; pos: string }>;
  currentPickIndex: number;
  totalPicks: number;
  /** All undrafted picks with their current owners (for finding trade partners). */
  remainingSchedule: Array<{ overall: number; round: number; currentTeam: string }>;
  strategyPrompt?: string;
  /** Top tradeable players on this team (by cap hit). */
  tradeablePlayers: TradeablePlayer[];
  /** Recent insider tweets that may influence trade decisions. */
  recentLeaks?: string[];
}

const LLM_TIMEOUT_MS = 15000;
const LLM_TIMEOUT_HUMAN_MS = 20000; // longer timeout for human-initiated trades

function withTimeout<T>(promise: Promise<T>, timeoutMs = LLM_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('TradeAI LLM timeout')), timeoutMs),
    ),
  ]);
}

function buildPickList(overalls: number[], chart: ValueChartType): string {
  return overalls.map(o => {
    const p = PROSPECT_BY_RANK.get(o);
    return `#${o} (value: ${getPickValue(o, chart)})`;
  }).join(', ');
}

function buildAvailableProspects(ranks: number[], limit = 20): string {
  return ranks.slice(0, limit).map(r => {
    const p = PROSPECT_BY_RANK.get(r);
    return p ? `${p.name} (${p.pos}, ${p.school})` : `#${r}`;
  }).join(', ');
}

function buildPlayerList(players: TradeablePlayer[]): string {
  if (!players.length) return 'none';
  return players.map(p =>
    `${p.name} (${p.pos}, cap: $${(p.capHit / 1000).toFixed(1)}M, incoming: $${(p.incomingCap / 1000).toFixed(1)}M)`
  ).join(', ');
}

function validatePlayerNames(names: string[] | undefined, teamAbbr: string): string[] {
  if (!names?.length) return [];
  const teamPlayers = TRADE_PLAYERS[teamAbbr];
  if (!teamPlayers) return [];
  return names.filter(n => teamPlayers[n.toLowerCase()]);
}

function buildLeakContext(leaks: string[] | undefined): string {
  if (!leaks?.length) return '';
  const items = leaks.slice(0, 5).map(t => `  - "${t}"`).join('\n');
  return `\nRecent insider reports (use these to identify trade opportunities):\n${items}\n`;
}

function buildGMSystemPrompt(profile: GMProfile, role: string): string {
  return `You are an NFL GM AI for the ${TEAMS[profile.team]?.name ?? profile.team}.
Personality: ${profile.personality}
Trade aggression: ${profile.tradeAggression}/1.0 | Risk tolerance: ${profile.riskTolerance}/1.0

${role}

${getValueChartPrompt(profile.valueChart)}

IMPORTANT: Return ONLY valid JSON matching the specified format. No explanation outside JSON.`;
}

// ── 1. Evaluate incoming trade ──────────────────────────────────────────────

interface RawTradeEval {
  decision: string;
  reasoning: string;
  counterOffer?: {
    offeredOveralls?: number[];
    requestedOveralls?: number[];
    offeredFuturePicks?: string[];
    requestedFuturePicks?: string[];
    offeredPlayers?: string[];
    requestedPlayers?: string[];
  };
}

export async function evaluateIncomingTrade(
  profile: GMProfile,
  ctx: TradeAIContext,
  proposal: {
    fromTeam: string;
    offeredOveralls: number[];
    requestedOveralls: number[];
    offeredFuturePicks: string[];
    requestedFuturePicks: string[];
    offeredPlayers?: string[];
    requestedPlayers?: string[];
  },
  humanInitiated = false,
): Promise<TradeEvaluation | null> {
  const start = Date.now();
  const chart = profile.valueChart;
  const { givingValue, receivingValue, ratio } = evaluateTradeValue(
    { overalls: proposal.requestedOveralls, futurePickIds: proposal.requestedFuturePicks },
    { overalls: proposal.offeredOveralls, futurePickIds: proposal.offeredFuturePicks },
    chart,
    (id: string) => {
      const fp = ctx.teamFuturePicks.find(f => f.id === id);
      return fp ? { year: fp.year, round: fp.round } : null;
    },
  );

  const playerNote = ctx.tradeablePlayers.length
    ? `\nYou may include rostered players in counter-offers. Your tradeable players: ${buildPlayerList(ctx.tradeablePlayers)}`
    : '';

  const system = buildGMSystemPrompt(profile, `You are evaluating a trade proposal. Decide: accept, decline, or counter.
Consider:
- Value balance (you are giving ${givingValue} pts, receiving ${receivingValue} pts, ratio ${ratio.toFixed(2)})
- Your team needs and draft position
- Your personality and risk tolerance
- Counter-offers should be reasonable adjustments, not completely different trades
${playerNote}

Return JSON: {"decision":"accept"|"decline"|"counter","reasoning":"<1-2 sentences>","counterOffer":{"offeredOveralls":[...],"requestedOveralls":[...],"offeredFuturePicks":[...],"requestedFuturePicks":[...],"offeredPlayers":[...],"requestedPlayers":[...]}}
counterOffer is required only if decision is "counter". In the counter, "offered" means picks/players YOU give, "requested" means picks/players you want.`);

  const offeredPlayersStr = proposal.offeredPlayers?.length ? `\nThey also offer players: ${proposal.offeredPlayers.join(', ')}` : '';
  const requestedPlayersStr = proposal.requestedPlayers?.length ? `\nThey also want players: ${proposal.requestedPlayers.join(', ')}` : '';

  const leakInfo = buildLeakContext(ctx.recentLeaks);

  const userMsg = `Trade proposal from ${proposal.fromTeam}:
They offer: picks ${buildPickList(proposal.offeredOveralls, chart)}${proposal.offeredFuturePicks.length ? `, future: ${proposal.offeredFuturePicks.join(', ')}` : ''}${offeredPlayersStr}
They want: picks ${buildPickList(proposal.requestedOveralls, chart)}${proposal.requestedFuturePicks.length ? `, future: ${proposal.requestedFuturePicks.join(', ')}` : ''}${requestedPlayersStr}

Your picks: ${buildPickList(ctx.teamPicks.map(p => p.overall), chart)}
Your future picks: ${ctx.teamFuturePicks.map(f => f.id).join(', ') || 'none'}
Already drafted: ${ctx.draftedByTeam.map(p => `${p.name} (${p.pos})`).join(', ') || 'none'}
${ctx.strategyPrompt ? `Strategy: ${ctx.strategyPrompt}` : ''}
Top available prospects: ${buildAvailableProspects(ctx.availableRanks)}${leakInfo}`;

  try {
    const timeout = humanInitiated ? LLM_TIMEOUT_HUMAN_MS : LLM_TIMEOUT_MS;
    const raw = await withTimeout(chatJSON<RawTradeEval>(system, userMsg), timeout);
    const decision = raw.decision?.toLowerCase();
    if (decision !== 'accept' && decision !== 'decline' && decision !== 'counter') return null;

    const ms = Date.now() - start;
    console.log(`[TradeAI] evaluateIncomingTrade for ${ctx.teamAbbr}: ${ms}ms → ${decision}`);

    return {
      decision: decision as 'accept' | 'decline' | 'counter',
      reasoning: raw.reasoning ?? '',
      counterOffer: decision === 'counter' && raw.counterOffer ? {
        offeredOveralls: raw.counterOffer.offeredOveralls ?? [],
        requestedOveralls: raw.counterOffer.requestedOveralls ?? [],
        offeredFuturePicks: raw.counterOffer.offeredFuturePicks ?? [],
        requestedFuturePicks: raw.counterOffer.requestedFuturePicks ?? [],
        offeredPlayers: validatePlayerNames(raw.counterOffer.offeredPlayers, ctx.teamAbbr),
        requestedPlayers: validatePlayerNames(raw.counterOffer.requestedPlayers, proposal.fromTeam),
      } : undefined,
    };
  } catch (err) {
    const ms = Date.now() - start;
    console.warn(`[TradeAI] evaluateIncomingTrade failed for ${ctx.teamAbbr} (${ms}ms):`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── 2. Generate a proactive trade idea ──────────────────────────────────────

interface RawTradeIdea {
  partnerTeam?: string;
  offeredOveralls?: number[];
  requestedOveralls?: number[];
  offeredFuturePicks?: string[];
  requestedFuturePicks?: string[];
  offeredPlayers?: string[];
  requestedPlayers?: string[];
  pitch?: string;
  noTrade?: boolean;
}

export async function generateTradeIdea(
  profile: GMProfile,
  ctx: TradeAIContext,
): Promise<TradeIdea | null> {
  const start = Date.now();

  const chart = profile.valueChart;

  // Build a summary of other teams' upcoming picks
  const otherTeamPicks = new Map<string, number[]>();
  for (const slot of ctx.remainingSchedule) {
    if (slot.currentTeam === ctx.teamAbbr) continue;
    const picks = otherTeamPicks.get(slot.currentTeam) ?? [];
    picks.push(slot.overall);
    otherTeamPicks.set(slot.currentTeam, picks);
  }
  const partnerSummary = [...otherTeamPicks.entries()]
    .slice(0, 12)
    .map(([team, picks]) => `${team}: ${picks.slice(0, 4).map(o => `#${o}`).join(', ')}`)
    .join('\n');

  const playerNote = ctx.tradeablePlayers.length
    ? `\nYou may include rostered players in trades. Your tradeable players: ${buildPlayerList(ctx.tradeablePlayers)}`
    : '';

  const system = buildGMSystemPrompt(profile, `You are looking for trade opportunities. Propose a trade with another team, or decline if nothing makes sense.
- Only propose trades where the value is reasonably balanced
- Consider which teams might want to trade up or down
- Your trade should align with your personality and team needs
- You may include rostered players in trades for added value
${playerNote}

Return JSON: {"partnerTeam":"<ABBR>","offeredOveralls":[...],"requestedOveralls":[...],"offeredFuturePicks":[...],"requestedFuturePicks":[...],"offeredPlayers":[...],"requestedPlayers":[...],"pitch":"<1 sentence pitch>"}
If no good trade exists: {"noTrade":true}`);

  const leakInfo = buildLeakContext(ctx.recentLeaks);

  const userMsg = `Your picks: ${buildPickList(ctx.teamPicks.map(p => p.overall), chart)}
Your future picks: ${ctx.teamFuturePicks.map(f => `${f.id} (value: ${getPickValue((f.round - 1) * 32 + 16, chart)})`).join(', ') || 'none'}
Already drafted: ${ctx.draftedByTeam.map(p => `${p.name} (${p.pos})`).join(', ') || 'none'}
Draft progress: pick ${ctx.currentPickIndex + 1} of ${ctx.totalPicks}
${ctx.strategyPrompt ? `Strategy: ${ctx.strategyPrompt}` : ''}
Top available prospects: ${buildAvailableProspects(ctx.availableRanks)}

Other teams' remaining picks:
${partnerSummary}${leakInfo}`;

  try {
    const raw = await withTimeout(chatJSON<RawTradeIdea>(system, userMsg));
    if (raw.noTrade || !raw.partnerTeam) {
      console.log(`[TradeAI] generateTradeIdea for ${ctx.teamAbbr}: ${Date.now() - start}ms → no-idea`);
      return null;
    }
    if (!TEAMS[raw.partnerTeam]) {
      console.log(`[TradeAI] generateTradeIdea for ${ctx.teamAbbr}: ${Date.now() - start}ms → invalid partner ${raw.partnerTeam}`);
      return null;
    }

    const ms = Date.now() - start;
    const idea: TradeIdea = {
      partnerTeam: raw.partnerTeam,
      offeredOveralls: raw.offeredOveralls ?? [],
      requestedOveralls: raw.requestedOveralls ?? [],
      offeredFuturePicks: raw.offeredFuturePicks ?? [],
      requestedFuturePicks: raw.requestedFuturePicks ?? [],
      offeredPlayers: validatePlayerNames(raw.offeredPlayers, ctx.teamAbbr),
      requestedPlayers: validatePlayerNames(raw.requestedPlayers, raw.partnerTeam),
      pitch: raw.pitch ?? 'Trade proposal',
    };
    console.log(`[TradeAI] generateTradeIdea for ${ctx.teamAbbr}: ${ms}ms → ${raw.partnerTeam}`);
    return idea;
  } catch (err) {
    const ms = Date.now() - start;
    console.warn(`[TradeAI] generateTradeIdea failed for ${ctx.teamAbbr} (${ms}ms):`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── 3. On-the-clock: pick or trade down? ────────────────────────────────────

interface RawOnClockDecision {
  action?: string;
  tradeIdea?: RawTradeIdea;
}

export async function decideOnClockTrade(
  profile: GMProfile,
  ctx: TradeAIContext,
  currentPick: { overall: number; round: number },
): Promise<OnClockDecision | null> {
  // Low-aggression GMs usually just pick
  if (Math.random() > profile.tradeAggression + 0.2) return { action: 'pick' };

  const start = Date.now();
  const chart = profile.valueChart;
  const currentValue = getPickValue(currentPick.overall, chart);

  const otherTeamPicks = new Map<string, number[]>();
  for (const slot of ctx.remainingSchedule) {
    if (slot.currentTeam === ctx.teamAbbr) continue;
    if (slot.overall <= currentPick.overall) continue; // only later picks
    const picks = otherTeamPicks.get(slot.currentTeam) ?? [];
    picks.push(slot.overall);
    otherTeamPicks.set(slot.currentTeam, picks);
  }
  const partnerSummary = [...otherTeamPicks.entries()]
    .slice(0, 10)
    .map(([team, picks]) => `${team}: ${picks.slice(0, 3).map(o => `#${o} (${getPickValue(o, chart)})`).join(', ')}`)
    .join('\n');

  const playerNote = ctx.tradeablePlayers.length
    ? `\nYou may include rostered players in a trade-down package. Your tradeable players: ${buildPlayerList(ctx.tradeablePlayers)}`
    : '';

  const system = buildGMSystemPrompt(profile, `You are ON THE CLOCK with pick #${currentPick.overall} (round ${currentPick.round}, value: ${currentValue}).
Decide: make your pick, or propose a trade-down to accumulate more picks.

Consider:
- Are the top available prospects worth this pick, or is there a drop-off where trading down makes sense?
- Would multiple later picks give you more total value?
- Your personality: aggressive GMs trade up, builders trade down, fortress GMs just pick
${playerNote}

Return JSON: {"action":"pick"} or {"action":"trade","tradeIdea":{"partnerTeam":"<ABBR>","offeredOveralls":[${currentPick.overall}],"requestedOveralls":[...],"offeredFuturePicks":[...],"requestedFuturePicks":[...],"offeredPlayers":[...],"requestedPlayers":[...],"pitch":"<1 sentence>"}}`);

  const leakInfo = buildLeakContext(ctx.recentLeaks);

  const userMsg = `Your pick #${currentPick.overall} (value: ${currentValue})
Your other picks: ${buildPickList(ctx.teamPicks.filter(p => p.overall !== currentPick.overall).map(p => p.overall), chart)}
Already drafted: ${ctx.draftedByTeam.map(p => `${p.name} (${p.pos})`).join(', ') || 'none'}
${ctx.strategyPrompt ? `Strategy: ${ctx.strategyPrompt}` : ''}
Top available: ${buildAvailableProspects(ctx.availableRanks, 10)}

Teams that might want to trade up:
${partnerSummary}${leakInfo}`;

  try {
    const raw = await withTimeout(chatJSON<RawOnClockDecision>(system, userMsg));
    const action = raw.action?.toLowerCase();
    if (action !== 'pick' && action !== 'trade') return { action: 'pick' };

    const ms = Date.now() - start;
    console.log(`[TradeAI] decideOnClockTrade for ${ctx.teamAbbr}: ${ms}ms → ${action}`);

    if (action === 'trade' && raw.tradeIdea?.partnerTeam && TEAMS[raw.tradeIdea.partnerTeam]) {
      return {
        action: 'trade',
        tradeIdea: {
          partnerTeam: raw.tradeIdea.partnerTeam,
          offeredOveralls: raw.tradeIdea.offeredOveralls ?? [currentPick.overall],
          requestedOveralls: raw.tradeIdea.requestedOveralls ?? [],
          offeredFuturePicks: raw.tradeIdea.offeredFuturePicks ?? [],
          requestedFuturePicks: raw.tradeIdea.requestedFuturePicks ?? [],
          offeredPlayers: validatePlayerNames(raw.tradeIdea.offeredPlayers, ctx.teamAbbr),
          requestedPlayers: validatePlayerNames(raw.tradeIdea.requestedPlayers, raw.tradeIdea.partnerTeam),
          pitch: raw.tradeIdea.pitch ?? 'Trade proposal',
        },
      };
    }

    return { action: 'pick' };
  } catch (err) {
    const ms = Date.now() - start;
    console.warn(`[TradeAI] decideOnClockTrade failed for ${ctx.teamAbbr} (${ms}ms):`, err instanceof Error ? err.message : err);
    return null;
  }
}
