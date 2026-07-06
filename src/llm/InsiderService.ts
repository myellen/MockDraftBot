/**
 * InsiderService — extracted from rumor.ts for reuse by both Discord command and web API.
 * Runs the full leaker → reporter two-stage LLM pipeline.
 * InsiderQueue processes pick/trade events sequentially, emitting insider:tweet events.
 */

import { TEAMS } from '../data/teams';
import { DRAFT_MODE } from '../data/draftMode';
import { isOllamaConfigured, chatJSON, chatText, LLMAbortError } from './OllamaService';
import type { DraftEngine } from '../engine/DraftEngine';
import { INSIDERS, buildLeakerPrompt, buildReporterPrompt } from './insiderData';

export { INSIDERS } from './insiderData';
export type { Insider } from './insiderData';

// ── Core generation function ───────────────────────────────────────────────

interface InsiderTweet {
  name: string;
  handle: string;
  avatar: string;
  tweet: string;
}

interface LeakerNugget {
  nugget: string;
  teams: string[];
  spiciness: number;
}

interface LeakerResponse {
  nuggets: LeakerNugget[];
}

interface DraftContext {
  leakerPrompt: string;
  recentPicks: Array<{ team: string; prospectName: string; pos: string; school: string; round: number; overall: number }>;
  teamNames: Record<string, string>;
}

function gatherDraftContext(engine: DraftEngine): DraftContext {
  const state = engine.getState();
  const teamNames: Record<string, string> = {};
  for (const [abbr, team] of Object.entries(TEAMS)) {
    teamNames[abbr] = team.name;
  }

  const recentTrades = (state.tradeHistory ?? []).slice(-15).map(t => ({
    proposerTeam: t.proposerTeam,
    receiverTeam: t.receiverTeam,
    offeredOveralls: t.offeredOveralls,
    requestedOveralls: t.requestedOveralls,
    offeredPlayers: t.offeredPlayers ?? [],
    requestedPlayers: t.requestedPlayers ?? [],
    offeredFuturePicks: t.offeredFuturePicks ?? [],
    requestedFuturePicks: t.requestedFuturePicks ?? [],
  }));

  const cancelledTrades = (state.cancelledTrades ?? []).slice(-15).map(t => ({
    proposerTeam: t.proposerTeam,
    receiverTeam: t.receiverTeam,
    cancelReason: t.cancelReason,
    offeredOveralls: t.offeredOveralls,
    requestedOveralls: t.requestedOveralls,
    offeredPlayers: t.offeredPlayers ?? [],
    requestedPlayers: t.requestedPlayers ?? [],
    offeredFuturePicks: t.offeredFuturePicks ?? [],
    requestedFuturePicks: t.requestedFuturePicks ?? [],
  }));

  const pendingTrades = (state.pendingTrades ?? []).map(t => ({
    proposerTeam: t.proposerTeam,
    receiverTeam: t.receiverTeam,
    offeredOveralls: t.offeredOveralls,
    requestedOveralls: t.requestedOveralls,
    offeredPlayers: t.offeredPlayers ?? [],
    requestedPlayers: t.requestedPlayers ?? [],
    offeredFuturePicks: t.offeredFuturePicks ?? [],
    requestedFuturePicks: t.requestedFuturePicks ?? [],
  }));

  const strategyNotes: Record<string, string[]> = {};
  for (const abbr of Object.keys(TEAMS)) {
    const notes = engine.getStrategyNotes(abbr);
    if (notes.length > 0) strategyNotes[abbr] = notes;
  }

  const recentPicks = engine.getLastNPicks(10).map(p => ({
    team: p.team,
    prospectName: p.prospectName,
    pos: p.pos,
    school: p.school,
    round: p.round,
    overall: p.overall,
  }));

  const slot = engine.getCurrentSlot();
  const currentPick = slot ? { overall: slot.overall, round: slot.round, team: slot.currentTeam } : null;

  const leakerPrompt = buildLeakerPrompt(
    recentTrades, cancelledTrades, pendingTrades,
    recentPicks, strategyNotes, currentPick, teamNames,
  );

  return { leakerPrompt, recentPicks, teamNames };
}

/**
 * Generate a single insider tweet using the full leaker → reporter pipeline.
 * Works with DraftEngine directly — no Discord dependency.
 *
 * The leaker prompt is built lazily (thunk) so that state is read at slot
 * acquisition time, not enqueue time — avoids stale data when queued.
 */
export async function generateInsiderTweet(engine: DraftEngine, signal?: AbortSignal): Promise<InsiderTweet> {
  if (!isOllamaConfigured()) {
    throw new Error('Ollama not configured');
  }

  // Leaker thunk defers state read to slot acquisition time
  let lastCtx: DraftContext | null = null;

  const leakerResult = await chatJSON<LeakerResponse>(
    () => {
      lastCtx = gatherDraftContext(engine);
      return lastCtx.leakerPrompt;
    },
    'Analyze the draft activity and extract the most interesting nuggets.',
    { temperature: 1.2, signal, priority: 'low' },
  );

  const ctx = lastCtx ?? gatherDraftContext(engine);

  // Pick insider + spiciest nugget → reporter writes tweet
  const insider = INSIDERS[Math.floor(Math.random() * INSIDERS.length)];
  const reporterPrompt = buildReporterPrompt(insider);

  let reporterInput: string;

  if (leakerResult.nuggets && leakerResult.nuggets.length > 0) {
    const sorted = leakerResult.nuggets.sort((a, b) => b.spiciness - a.spiciness);
    const topTier = sorted.filter(n => n.spiciness >= sorted[0].spiciness - 1);
    const chosen = topTier[Math.floor(Math.random() * topTier.length)];
    reporterInput = `Write a tweet based on this intel: ${chosen.nugget}`;
  } else {
    const fallbackContext = ctx.recentPicks.length > 0
      ? `A recent pick: the ${ctx.teamNames[ctx.recentPicks[0].team]} selected ${ctx.recentPicks[0].prospectName} (${ctx.recentPicks[0].pos}, ${ctx.recentPicks[0].school}) in round ${ctx.recentPicks[0].round}. The front office loved this player and had a much higher grade on him than where he was taken.`
      : 'Pre-draft buzz: teams are actively working the phones and evaluating prospects. Generate a vague but exciting rumor about draft day preparations.';
    reporterInput = `Write a tweet based on this intel: ${fallbackContext}`;
  }

  let tweet = await chatText(reporterPrompt, reporterInput, { temperature: 1.2, signal, priority: 'low' });
  tweet = tweet.replace(/^["'\u201C\u201D\u2018\u2019]|["'\u201C\u201D\u2018\u2019]$/g, '').trim();
  if (tweet.length > 280) tweet = tweet.slice(0, 277) + '...';

  return {
    name: insider.name,
    handle: insider.handle,
    avatar: insider.avatar,
    tweet,
  };
}

// ── InsiderQueue — deterministic pick/trade color commentary ────────────────
// No LLM calls. Templates produce Draft Tracker / League Sources / NFL Draft Wire tweets.

const QUEUE_MIN_GAP_MS = 4000;
const QUEUE_MAX_DEPTH = 15;

interface FeedPersona { name: string; handle: string; }
const FEED_PERSONAS: FeedPersona[] = [
  { name: 'NFL Draft Wire', handle: '@NFLDraftWire' },
  { name: 'Draft Tracker', handle: '@DraftTracker' },
  { name: 'League Sources', handle: '@LeagueSources' },
];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

function pickTweet(teamName: string, prospectName: string, pos: string, school: string, round: number, overall: number): string {
  // In redraft mode `school` is the player's (former) NFL team — "out of
  // Kansas City Chiefs" reads wrong, "formerly of the Chiefs" doesn't.
  const redraft = DRAFT_MODE === 'redraft';
  const outOf = redraft ? `formerly of the ${school}` : `out of ${school}`;
  const fromSchool = redraft ? `the ${school}` : school;
  const schoolPos = redraft ? `former ${school} ${pos}` : `${school} ${pos}`;
  const templates = [
    `${teamName} locks in ${prospectName} (${pos}, ${school}) at #${overall}. ${round <= 2 ? 'Big-time selection.' : 'Solid value here.'}`,
    `Pick #${overall}: ${prospectName} heads to ${teamName}. The ${pos} ${outOf} fills a need.`,
    `${teamName} adds ${prospectName} from ${fromSchool}. Front office was clearly targeting ${pos} in round ${round}.`,
    `${prospectName} (${pos}) goes #${overall} to ${teamName}. Draft room is feeling good about this one.`,
    `The ${pos} from ${fromSchool}, ${prospectName}, is heading to ${teamName} at pick ${overall}.`,
  ];
  if (round === 1) {
    templates.push(
      `First-round talent secured: ${teamName} takes ${prospectName} at #${overall}. The ${schoolPos} was high on a lot of boards.`,
      `Round 1 pick locked in — ${teamName} goes with ${prospectName} ${outOf}. A statement pick.`,
    );
  }
  if (round >= 4) {
    templates.push(
      `Day 3 find: ${teamName} grabs ${prospectName} (${pos}, ${school}) at #${overall}. Could be a steal.`,
      `${teamName} adds depth with ${prospectName} ${outOf}. Smart pick in round ${round}.`,
    );
  }
  return pick(templates);
}

function tradeTweet(team1: string, team2: string): string {
  const templates = [
    `Trade is official — ${team1} and ${team2} swap assets. Both front offices worked fast to get this done.`,
    `${team1} and ${team2} finalize a deal. The phones were ringing for a while on this one.`,
    `Confirmed: ${team1} and ${team2} complete a trade. Draft boards shifting across the league.`,
    `${team1} ↔ ${team2} — the trade is done. Sources say both sides feel good about the return.`,
    `Deal done between ${team1} and ${team2}. This draft keeps delivering surprises.`,
  ];
  return pick(templates);
}

export class InsiderQueue {
  private queue: Array<{ engine: DraftEngine; isTrade: boolean }> = [];
  private processing = false;
  private stopped = false;

  enqueue(engine: DraftEngine, isTrade = false): void {
    if (this.stopped) return;
    if (this.queue.length >= QUEUE_MAX_DEPTH) {
      this.queue.splice(0, this.queue.length - Math.floor(QUEUE_MAX_DEPTH / 2));
    }
    this.queue.push({ engine, isTrade });
    if (!this.processing) void this.processQueue();
  }

  stop(): void { this.stopped = true; this.queue = []; }
  start(): void { this.stopped = false; }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0 && !this.stopped) {
      const item = this.queue.shift()!;
      const persona = pick(FEED_PERSONAS);
      const state = item.engine.getState();

      let tweet: string;
      if (item.isTrade) {
        const t = (state.tradeHistory ?? []).at(-1);
        const t1 = TEAMS[t?.proposerTeam ?? '']?.name ?? t?.proposerTeam ?? '???';
        const t2 = TEAMS[t?.receiverTeam ?? '']?.name ?? t?.receiverTeam ?? '???';
        tweet = tradeTweet(t1, t2);
      } else {
        const p = state.picks?.at(-1);
        if (!p) { continue; }
        const teamName = TEAMS[p.team]?.name ?? p.team;
        tweet = pickTweet(teamName, p.prospectName, p.pos, p.school, p.round, p.overall);
      }

      item.engine.emit('insider:tweet', {
        name: persona.name,
        handle: persona.handle,
        avatar: '',
        tweet,
      });
      console.log(`[InsiderQueue] ${persona.name}: ${tweet.slice(0, 80)}...`);

      if (this.queue.length > 0) {
        await new Promise(r => setTimeout(r, QUEUE_MIN_GAP_MS));
      }
    }

    this.processing = false;
  }
}
