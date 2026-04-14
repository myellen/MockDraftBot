/**
 * InsiderService — extracted from rumor.ts for reuse by both Discord command and web API.
 * Runs the full leaker → reporter two-stage LLM pipeline.
 * InsiderQueue processes pick/trade events sequentially, emitting insider:tweet events.
 */

import { TEAMS } from '../data/teams';
import { isOllamaConfigured, chatJSON, chatText } from './OllamaService';
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

/**
 * Generate a single insider tweet using the full leaker → reporter pipeline.
 * Works with DraftEngine directly — no Discord dependency.
 */
export async function generateInsiderTweet(engine: DraftEngine): Promise<InsiderTweet> {
  if (!isOllamaConfigured()) {
    throw new Error('Ollama not configured');
  }

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

  // Step 1: Leaker extracts nuggets
  const leakerPrompt = buildLeakerPrompt(
    recentTrades, cancelledTrades, pendingTrades,
    recentPicks, strategyNotes, currentPick, teamNames,
  );

  const leakerResult = await chatJSON<LeakerResponse>(leakerPrompt, 'Analyze the draft activity and extract the most interesting nuggets.', 1.2);

  // Step 2: Pick insider + spiciest nugget → reporter writes tweet
  const insider = INSIDERS[Math.floor(Math.random() * INSIDERS.length)];
  const reporterPrompt = buildReporterPrompt(insider);

  let reporterInput: string;

  if (leakerResult.nuggets && leakerResult.nuggets.length > 0) {
    const sorted = leakerResult.nuggets.sort((a, b) => b.spiciness - a.spiciness);
    const topTier = sorted.filter(n => n.spiciness >= sorted[0].spiciness - 1);
    const chosen = topTier[Math.floor(Math.random() * topTier.length)];
    reporterInput = `Write a tweet based on this intel: ${chosen.nugget}`;
  } else {
    const fallbackContext = recentPicks.length > 0
      ? `A recent pick: the ${teamNames[recentPicks[0].team]} selected ${recentPicks[0].prospectName} (${recentPicks[0].pos}, ${recentPicks[0].school}) in round ${recentPicks[0].round}. The front office loved this player and had a much higher grade on him than where he was taken.`
      : 'Pre-draft buzz: teams are actively working the phones and evaluating prospects. Generate a vague but exciting rumor about draft day preparations.';
    reporterInput = `Write a tweet based on this intel: ${fallbackContext}`;
  }

  let tweet = await chatText(reporterPrompt, reporterInput, 1.2);
  tweet = tweet.replace(/^["'\u201C\u201D\u2018\u2019]|["'\u201C\u201D\u2018\u2019]$/g, '').trim();
  if (tweet.length > 280) tweet = tweet.slice(0, 277) + '...';

  return {
    name: insider.name,
    handle: insider.handle,
    avatar: insider.avatar,
    tweet,
  };
}

// ── InsiderQueue — processes pick/trade events into insider tweets ──────────

const QUEUE_MIN_GAP_MS = 5000;
const QUEUE_MAX_DEPTH = 10;

export class InsiderQueue {
  private queue: Array<{ engine: DraftEngine; priority: boolean }> = [];
  private processing = false;
  private stopped = false;

  enqueue(engine: DraftEngine, priority = false): void {
    if (this.stopped) return;

    // If queue is too deep, consolidate oldest non-priority items
    if (this.queue.length >= QUEUE_MAX_DEPTH) {
      // Keep priority items and the most recent half
      const priorityItems = this.queue.filter(q => q.priority);
      const normalItems = this.queue.filter(q => !q.priority);
      const keepNormal = normalItems.slice(-Math.floor(QUEUE_MAX_DEPTH / 2));
      this.queue = [...priorityItems, ...keepNormal];
    }

    if (priority) {
      // Trade events go to front (after other priority items)
      let lastPriority = -1;
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (this.queue[i].priority) { lastPriority = i; break; }
      }
      this.queue.splice(lastPriority + 1, 0, { engine, priority: true });
    } else {
      this.queue.push({ engine, priority: false });
    }

    if (!this.processing) {
      void this.processQueue();
    }
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
  }

  start(): void {
    this.stopped = false;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0 && !this.stopped) {
      const item = this.queue.shift()!;
      try {
        const result = await generateInsiderTweet(item.engine);
        item.engine.emit('insider:tweet', result);
        console.log(`[InsiderQueue] Tweet by ${result.name}: ${result.tweet.slice(0, 80)}...`);
      } catch (err) {
        console.error('[InsiderQueue] Failed to generate tweet:', err instanceof Error ? err.message : err);
      }

      // Minimum gap between tweets
      if (this.queue.length > 0) {
        await new Promise(r => setTimeout(r, QUEUE_MIN_GAP_MS));
      }
    }

    this.processing = false;
  }
}
