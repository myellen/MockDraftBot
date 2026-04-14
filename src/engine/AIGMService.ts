/**
 * AI GM Service — deliberation-based orchestrator for CPU trade agents.
 *
 * Per pick, runs a deliberation phase:
 *   1. Heuristic scores all 32 GMs (<1ms, no LLM)
 *   2. Top 3-4 candidates get sequential LLM calls
 *   3. For each: generateTradeIdea → if idea, partner evaluates → execute/decline
 *   4. trade:chatter events emitted for social feed
 *   5. After deliberation: on-clock team autopicks (if CPU)
 *
 * CPU turn (30s):  Deliberation blocks the advance loop.
 * Human turn:      Deliberation runs fire-and-forget, cancelled on pick.
 *
 * Hard constraint: Ollama Cloud Free tier = 1 concurrent LLM call.
 * At ~8s per call, we get 3-4 calls per 30s window.
 */

import type { DraftState, PendingTrade, PickSlot, FuturePickRight, TradeLogEntry } from './types';
import type { DraftEventMap } from './events';
import type { TradeEngine } from './TradeEngine';
import { getGMProfile, type GMProfile, type GMArchetype } from '../data/gmProfiles';
import { TEAMS } from '../data/teams';
import { DEFAULT_STRATEGY_PROMPTS } from '../data/teamProfiles';
import { isTradeReasonable, getPickValue } from './tradeValue';
import { TRADE_PLAYERS } from '../data/capData';
import { ROSTERS } from '../data/rosters';
import {
  evaluateIncomingTrade,
  generateTradeIdea,
  decideOnClockTrade,
  type TradeAIContext,
  type TradeIdea,
  type TradeEvaluation,
  type TradeablePlayer,
} from '../llm/TradeAI';
import { isOllamaConfigured } from '../llm/OllamaService';

// ── Types ───────────────────────────────────────────────────────────────────

export interface LeakEntry {
  timestamp: number;
  leakerTeam: string | null;   // team that leaked (null if anonymous)
  intel: string;               // raw user input
  tweet: string;               // generated insider tweet
  mentionedTeams: string[];    // team abbreviations found in the tweet
}

export interface CPUOffer {
  id: string;
  proposerTeam: string;
  receiverTeam: string;
  offeredOveralls: number[];
  requestedOveralls: number[];
  offeredFuturePicks: string[];
  requestedFuturePicks: string[];
  offeredPlayers: string[];
  requestedPlayers: string[];
  pitch: string;
  createdAt: number;
  isCounter: boolean;
  originalOfferId?: string;
}

interface AIGMHost {
  getState(): Readonly<DraftState>;
  getBoardData(): { strategyPrompts: Record<string, string> };
  getTradeManager(): TradeEngine;
  emit<K extends keyof DraftEventMap>(event: K, data: DraftEventMap[K]): void;
  persist(): Promise<void>;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DELIBERATION_MS = 60_000;
const HEURISTIC_THRESHOLD = 15;
const MAX_CANDIDATES = 4;
const BREATHE_MS = 3_000;
const LEAK_DECAY_MS = 10 * 60_000;  // leaks influence AI for 10 minutes
const LEAK_HEURISTIC_BOOST = 15;    // bonus score for teams mentioned in leaks

// ── Service ─────────────────────────────────────────────────────────────────

export class AIGMService {
  private pendingCPUOffers = new Map<string, CPUOffer>();
  private lastTradeTime = new Map<string, number>();
  private deliberationAbort: AbortController | null = null;
  private tradeLog: TradeLogEntry[] = [];
  private recentLeaks: LeakEntry[] = [];

  constructor(private host: AIGMHost) {}

  // ── Public API ──────────────────────────────────────────────────────────

  getTradeLog(): TradeLogEntry[] { return this.tradeLog; }
  clearTradeLog(): void { this.tradeLog = []; }

  /** Clear all AI GM state on draft reset. */
  reset(): void {
    this.cancelDeliberation();
    this.pendingCPUOffers.clear();
    this.lastTradeTime.clear();
    this.tradeLog = [];
    this.recentLeaks = [];
  }

  /** Evaluate a human-proposed trade and accept/decline it as the CPU GM. */
  async handleHumanProposal(trade: PendingTrade): Promise<void> {
    console.log(`[AIGM] Evaluating human proposal: ${trade.proposerTeam} → ${trade.receiverTeam}`);
    const start = Date.now();

    const evaluation = await this.evaluateHumanProposal(trade);
    const ms = Date.now() - start;

    const removePending = () => {
      const s = this.host.getState() as DraftState;
      s.pendingTrades = s.pendingTrades.filter(t => t.id !== trade.id);
    };

    if (!evaluation) {
      console.log(`[AIGM] Human proposal evaluation timeout (${(ms / 1000).toFixed(1)}s)`);
      this.host.getTradeManager().recordCancelledTrade(trade, 'declined');
      removePending();
      await this.host.persist();
      this.host.emit('trade:cancelled', { trade, reason: 'declined', reasoning: 'GM did not respond in time.' });
      return;
    }

    console.log(`[AIGM] Human proposal: ${trade.receiverTeam} ${evaluation.decision.toUpperCase()} (${(ms / 1000).toFixed(1)}s) | "${evaluation.reasoning}"`);

    if (evaluation.decision === 'accept') {
      removePending();
      const result = await this.host.getTradeManager().executeCPUTrade(trade);
      if (!result.success) {
        console.warn(`[AIGM] Human proposal execution failed: ${result.error}`);
        this.host.getTradeManager().recordCancelledTrade(trade, 'declined');
        this.host.emit('trade:cancelled', { trade, reason: 'declined', reasoning: result.error ?? 'Trade could not be completed.' });
      }
    } else {
      this.host.getTradeManager().recordCancelledTrade(trade, 'declined');
      removePending();
      await this.host.persist();
      this.host.emit('trade:cancelled', { trade, reason: 'declined', reasoning: evaluation.reasoning });
    }
  }

  /** Register a leak so AI GMs factor it into trade decisions. */
  addLeak(leakerTeam: string | null, intel: string, tweet: string): void {
    // Extract mentioned team abbreviations from the tweet
    const allAbbrs = Object.keys(TEAMS);
    const tweetLower = tweet.toLowerCase();
    const mentionedTeams = allAbbrs.filter(abbr => {
      const teamName = TEAMS[abbr]?.name?.toLowerCase() ?? '';
      const city = TEAMS[abbr]?.city?.toLowerCase() ?? '';
      return tweetLower.includes(abbr.toLowerCase())
        || (teamName && tweetLower.includes(teamName))
        || (city && city.length > 3 && tweetLower.includes(city));
    });

    this.recentLeaks.push({ timestamp: Date.now(), leakerTeam, intel, tweet, mentionedTeams });
    // Cap at 20 entries
    if (this.recentLeaks.length > 20) this.recentLeaks.shift();
    console.log(`[AIGM] Leak registered from ${leakerTeam ?? 'anonymous'} — mentions: ${mentionedTeams.join(', ') || 'none'}`);
  }

  /** Get active (non-expired) leaks. */
  private getActiveLeaks(): LeakEntry[] {
    const cutoff = Date.now() - LEAK_DECAY_MS;
    return this.recentLeaks.filter(l => l.timestamp > cutoff);
  }

  cancelDeliberation(): void {
    if (this.deliberationAbort) {
      this.deliberationAbort.abort();
      this.deliberationAbort = null;
    }
  }

  /**
   * CPU team is on the clock. Runs a ~30s deliberation phase.
   * Returns true if a trade was executed (caller should NOT pick).
   */
  async onCPUTurn(slot: PickSlot): Promise<boolean> {
    if (!this.isEnabled() || !isOllamaConfigured()) return false;
    this.cancelDeliberation();
    this.deliberationAbort = new AbortController();
    return this.runDeliberation(slot, DELIBERATION_MS, false);
  }

  /**
   * Human is on the clock. Fire-and-forget background deliberation.
   */
  async onHumanTurn(slot: PickSlot): Promise<void> {
    if (!this.isEnabled() || !isOllamaConfigured()) return;
    const timerMs = this.host.getState().config.timerSeconds
      ? this.host.getState().config.timerSeconds! * 1000
      : 60_000;
    this.cancelDeliberation();
    this.deliberationAbort = new AbortController();
    void this.runDeliberation(slot, timerMs, true).catch(() => {});
  }

  /**
   * A pick was made. Clean up expired offers.
   */
  async onPickMade(_pick: { team: string; pos: string; prospectName: string }): Promise<void> {
    this.cleanExpiredOffers();
  }

  // ── Deliberation loop ──────────────────────────────────────────────────

  private async runDeliberation(
    _slot: PickSlot,
    durationMs: number,
    isBackground: boolean,
  ): Promise<boolean> {
    const deadline = Date.now() + durationMs;
    const signal = this.deliberationAbort?.signal;
    let tradeExecuted = false;

    while (Date.now() < deadline) {
      if (signal?.aborted) break;

      const state = this.host.getState();
      if (state.status !== 'active') break;
      const currentSlot = state.schedule[state.currentPickIndex];
      if (!currentSlot) break;
      const onClockTeam = currentSlot.currentTeam;
      const pickOverall = currentSlot.overall;

      // Score and rank all GMs
      const allTeams = Object.keys(TEAMS);
      const activeLeaks = this.getActiveLeaks();
      const scored = allTeams
        .filter(t => t !== onClockTeam)
        .map(t => ({ team: t, score: this.scoreGMForTrade(t, onClockTeam, pickOverall, state, activeLeaks) }))
        .filter(c => c.score > HEURISTIC_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_CANDIDATES);

      // Log heuristic results
      const heuristicStr = scored.map(c => `${c.team}(${c.score})`).join(' ');
      console.log(`[AIGM] Pick #${pickOverall} | Heuristic: ${heuristicStr} | ${scored.length} candidates`);
      this.log({ pickOverall, phase: 'heuristic', team: onClockTeam, durationMs: 0,
        result: 'filtered', details: `${scored.length} candidates: ${heuristicStr}` });

      for (const candidate of scored) {
        if (Date.now() >= deadline || signal?.aborted) break;

        const start = Date.now();
        const profile = getGMProfile(candidate.team);
        const ctx = this.buildContext(candidate.team, state);

        // 1 LLM call: generate trade idea
        const idea = await generateTradeIdea(profile, ctx);
        const genMs = Date.now() - start;

        if (!idea) {
          console.log(`[AIGM] Pick #${pickOverall} | ${candidate.team} generate | ${(genMs / 1000).toFixed(1)}s | no idea`);
          this.log({ pickOverall, phase: 'generate', team: candidate.team, durationMs: genMs, result: 'no-idea' });
          continue;
        }

        // Resolve LLM future pick references to real IDs
        idea.offeredFuturePicks = this.resolveFuturePicks(idea.offeredFuturePicks, candidate.team, state);
        idea.requestedFuturePicks = this.resolveFuturePicks(idea.requestedFuturePicks, idea.partnerTeam, state);

        // Validate both sides have assets and pick ownership
        const ownershipCheck = this.validateTradeIdea(candidate.team, idea, state);
        if (ownershipCheck) {
          console.log(`[AIGM] Pick #${pickOverall} | ${candidate.team} generate | ${(genMs / 1000).toFixed(1)}s | BLOCKED (${ownershipCheck})`);
          this.log({ pickOverall, phase: 'block', team: candidate.team, partnerTeam: idea.partnerTeam,
            durationMs: genMs, result: 'blocked-unreasonable', details: ownershipCheck });
          continue;
        }

        // Hard guardrail check
        const futurePicks = state.futurePickRights;
        const offeredFuture = idea.offeredFuturePicks
          .map(id => futurePicks.find(f => f.id === id))
          .filter((f): f is FuturePickRight => !!f)
          .map(f => ({ year: f.year, round: f.round }));
        const requestedFuture = idea.requestedFuturePicks
          .map(id => futurePicks.find(f => f.id === id))
          .filter((f): f is FuturePickRight => !!f)
          .map(f => ({ year: f.year, round: f.round }));

        // Skip value check if only players involved
        const hasPicksOrFuture = idea.offeredOveralls.length > 0 || idea.requestedOveralls.length > 0
          || offeredFuture.length > 0 || requestedFuture.length > 0;

        if (hasPicksOrFuture && !isTradeReasonable(idea.offeredOveralls, idea.requestedOveralls, offeredFuture, requestedFuture)) {
          const details = this.formatTradeIdea(candidate.team, idea);
          console.log(`[AIGM] Pick #${pickOverall} | ${candidate.team} generate | ${(genMs / 1000).toFixed(1)}s | BLOCKED (unreasonable) | ${details}`);
          this.log({ pickOverall, phase: 'block', team: candidate.team, partnerTeam: idea.partnerTeam,
            durationMs: genMs, result: 'blocked-unreasonable', details });
          continue;
        }

        const details = this.formatTradeIdea(candidate.team, idea);
        console.log(`[AIGM] Pick #${pickOverall} | ${candidate.team} generate | ${(genMs / 1000).toFixed(1)}s | idea: ${details}`);
        this.log({ pickOverall, phase: 'generate', team: candidate.team, partnerTeam: idea.partnerTeam,
          durationMs: genMs, result: 'idea', details });

        // Emit chatter: negotiating
        this.emitChatter(candidate.team, idea.partnerTeam, 'negotiating', idea.pitch);

        // Check if partner is human
        const partnerIsHuman = !!state.assignments[idea.partnerTeam];
        if (partnerIsHuman) {
          await this.sendCPUOfferToHuman(candidate.team, idea, state);
          continue;
        }

        if (Date.now() >= deadline || signal?.aborted) break;

        // 1 LLM call: partner evaluates
        const evalStart = Date.now();
        const receiverProfile = getGMProfile(idea.partnerTeam);
        const receiverCtx = this.buildContext(idea.partnerTeam, state);

        const evaluation = await evaluateIncomingTrade(receiverProfile, receiverCtx, {
          fromTeam: candidate.team,
          offeredOveralls: idea.offeredOveralls,
          requestedOveralls: idea.requestedOveralls,
          offeredFuturePicks: idea.offeredFuturePicks,
          requestedFuturePicks: idea.requestedFuturePicks,
          offeredPlayers: idea.offeredPlayers,
          requestedPlayers: idea.requestedPlayers,
        });
        const evalMs = Date.now() - evalStart;

        if (!evaluation) {
          console.log(`[AIGM] Pick #${pickOverall} | ${idea.partnerTeam} evaluate | ${(evalMs / 1000).toFixed(1)}s | TIMEOUT`);
          this.log({ pickOverall, phase: 'evaluate', team: idea.partnerTeam, partnerTeam: candidate.team,
            durationMs: evalMs, result: 'timeout' });
          continue;
        }

        console.log(`[AIGM] Pick #${pickOverall} | ${idea.partnerTeam} evaluate | ${(evalMs / 1000).toFixed(1)}s | ${evaluation.decision.toUpperCase()} | "${evaluation.reasoning}"`);
        this.log({ pickOverall, phase: 'evaluate', team: idea.partnerTeam, partnerTeam: candidate.team,
          durationMs: evalMs, result: evaluation.decision as any, reasoning: evaluation.reasoning });

        if (evaluation.decision === 'accept') {
          const trade = this.buildTrade(candidate.team, idea);
          const result = await this.host.getTradeManager().executeCPUTrade(trade);
          if (result.success) {
            console.log(`[AIGM] Pick #${pickOverall} | TRADE EXECUTED: ${candidate.team} ↔ ${idea.partnerTeam} | ${details}`);
            this.log({ pickOverall, phase: 'execute', team: candidate.team, partnerTeam: idea.partnerTeam,
              durationMs: Date.now() - start, result: 'executed', details });
            this.lastTradeTime.set(candidate.team, Date.now());
            this.lastTradeTime.set(idea.partnerTeam, Date.now());
            this.emitChatter(candidate.team, idea.partnerTeam, 'executed', evaluation.reasoning);
            tradeExecuted = true;
            break; // trade changed the board, re-evaluate
          }
          console.warn(`[AIGM] Pick #${pickOverall} | Trade execution failed: ${result.error}`);
          this.log({ pickOverall, phase: 'execute', team: candidate.team, partnerTeam: idea.partnerTeam,
            durationMs: Date.now() - start, result: 'error', error: result.error });
        }

        if (evaluation.decision === 'counter' && evaluation.counterOffer && Date.now() < deadline && !signal?.aborted) {
          this.emitChatter(candidate.team, idea.partnerTeam, 'counter', evaluation.reasoning);
          const counterResult = await this.handleCPUCounter(candidate.team, idea.partnerTeam, evaluation, state);
          if (counterResult) {
            tradeExecuted = true;
            break;
          }
        }

        if (evaluation.decision === 'decline') {
          this.emitChatter(candidate.team, idea.partnerTeam, 'declined', evaluation.reasoning);
          this.host.getTradeManager().recordCancelledTrade(this.buildTrade(candidate.team, idea), 'declined');
        }
      }

      // If we processed all candidates but time remains, breathe before next wave
      if (Date.now() < deadline && !tradeExecuted && !signal?.aborted) {
        await delay(BREATHE_MS);
      }
      if (tradeExecuted) break;
    }

    // On-clock team's own trade-down decision (if CPU and no trade yet)
    if (!isBackground && !tradeExecuted && Date.now() < deadline && !signal?.aborted) {
      const state = this.host.getState();
      if (state.status === 'active') {
        const currentSlot = state.schedule[state.currentPickIndex];
        if (currentSlot) {
          const onClockProfile = getGMProfile(currentSlot.currentTeam);
          const onClockCtx = this.buildContext(currentSlot.currentTeam, state);
          const start = Date.now();
          const decision = await decideOnClockTrade(onClockProfile, onClockCtx, {
            overall: currentSlot.overall,
            round: currentSlot.round,
          });
          const ms = Date.now() - start;

          console.log(`[AIGM] Pick #${currentSlot.overall} | ${currentSlot.currentTeam} on-clock | ${(ms / 1000).toFixed(1)}s | ${decision?.action ?? 'pick'}`);
          this.log({ pickOverall: currentSlot.overall, phase: 'on-clock', team: currentSlot.currentTeam,
            durationMs: ms, result: decision?.action === 'trade' ? 'idea' : 'no-idea' });

          if (decision?.action === 'trade' && decision.tradeIdea) {
            decision.tradeIdea.offeredFuturePicks = this.resolveFuturePicks(decision.tradeIdea.offeredFuturePicks, currentSlot.currentTeam, state);
            decision.tradeIdea.requestedFuturePicks = this.resolveFuturePicks(decision.tradeIdea.requestedFuturePicks, decision.tradeIdea.partnerTeam, state);
            const executed = await this.attemptCPUToCPUTrade(currentSlot.currentTeam, decision.tradeIdea, state);
            if (executed) return true;
          }
        }
      }
    }

    return tradeExecuted;
  }

  // ── Heuristic scoring (no LLM) ────────────────────────────────────────

  private scoreGMForTrade(
    teamAbbr: string,
    onClockTeam: string,
    onClockPick: number,
    state: Readonly<DraftState>,
    activeLeaks: LeakEntry[],
  ): number {
    const profile = getGMProfile(teamAbbr);
    let score = 0;

    // 1. Trade aggression (0-30 pts)
    score += profile.tradeAggression * 30;

    // 2. Pick proximity: teams with picks within 10 slots of current (0-20 pts)
    const remaining = state.schedule.slice(state.currentPickIndex);
    const teamPicks = remaining.filter(s => s.currentTeam === teamAbbr);
    const closestDist = teamPicks.reduce((min, s) => Math.min(min, Math.abs(s.overall - onClockPick)), 999);
    if (closestDist <= 10) score += 20 - closestDist * 2;

    // 3. Value chart divergence from on-clock team (0-15 pts)
    const onClockProfile = getGMProfile(onClockTeam);
    if (profile.valueChart !== onClockProfile.valueChart) score += 10;
    if (Math.abs(profile.riskTolerance - onClockProfile.riskTolerance) > 0.3) score += 5;

    // 4. Archetype bonus
    score += this.archetypeBonus(profile.archetype, onClockPick);

    // 5. Recent activity cooldown
    const lastTrade = this.lastTradeTime.get(teamAbbr);
    if (lastTrade && Date.now() - lastTrade < 60_000) score -= 10;

    // 6. Leak boost — teams mentioned in recent insider leaks are more active
    for (const leak of activeLeaks) {
      if (leak.mentionedTeams.includes(teamAbbr)) {
        score += LEAK_HEURISTIC_BOOST;
        break; // one boost per team regardless of multiple leaks
      }
    }

    // 7. Random jitter (0-5)
    score += Math.random() * 5;

    // Skip human-controlled teams for CPU↔CPU deliberation
    if (state.assignments[teamAbbr]) score = 0;

    return Math.round(score);
  }

  private archetypeBonus(archetype: GMArchetype, pickOverall: number): number {
    const isTopPick = pickOverall <= 32;
    switch (archetype) {
      case 'builder': return isTopPick ? 8 : 3;
      case 'gunslinger': return isTopPick ? 6 : 2;
      case 'dealmaker': return 5;
      case 'closer': return 4;
      case 'opportunist': return 3;
      case 'fortress': return -5;
      case 'architect': return 0;
      case 'veteran': return 0;
      default: return 0;
    }
  }

  // ── Tradeable players ─────────────────────────────────────────────────

  getTradeablePlayers(teamAbbr: string): TradeablePlayer[] {
    const capData = TRADE_PLAYERS[teamAbbr];
    if (!capData) return [];

    const roster = ROSTERS[teamAbbr] ?? [];
    const rosterMap = new Map(roster.map(p => [p.name.toLowerCase(), p]));

    const players: TradeablePlayer[] = [];
    for (const [nameLower, vals] of Object.entries(capData)) {
      // Skip players with terrible dead cap ratio (> 80% dead)
      if (vals.deadCap > vals.capHit * 0.8) continue;

      const rosterEntry = rosterMap.get(nameLower);
      const pos = rosterEntry?.pos ?? '??';
      // Title case the name
      const name = nameLower.replace(/\b\w/g, c => c.toUpperCase());

      players.push({ name, pos, capHit: vals.capHit, incomingCap: vals.incomingCap });
    }

    // Top 8 by cap hit
    return players.sort((a, b) => b.capHit - a.capHit).slice(0, 8);
  }

  // ── CPU → Human offers ────────────────────────────────────────────────

  private async sendCPUOfferToHuman(
    cpuTeam: string,
    idea: TradeIdea,
    state: Readonly<DraftState>,
  ): Promise<void> {
    // Validate ownership and non-empty sides
    const check = this.validateTradeIdea(cpuTeam, idea, state);
    if (check) {
      console.warn(`[AIGM] Blocked CPU→human offer from ${cpuTeam}: ${check}`);
      return;
    }

    const futurePicks = state.futurePickRights;
    const offeredFuture = idea.offeredFuturePicks
      .map(id => futurePicks.find(f => f.id === id))
      .filter((f): f is FuturePickRight => !!f)
      .map(f => ({ year: f.year, round: f.round }));
    const requestedFuture = idea.requestedFuturePicks
      .map(id => futurePicks.find(f => f.id === id))
      .filter((f): f is FuturePickRight => !!f)
      .map(f => ({ year: f.year, round: f.round }));

    const hasPicksOrFuture = idea.offeredOveralls.length > 0 || idea.requestedOveralls.length > 0
      || offeredFuture.length > 0 || requestedFuture.length > 0;

    if (hasPicksOrFuture && !isTradeReasonable(idea.offeredOveralls, idea.requestedOveralls, offeredFuture, requestedFuture)) {
      console.warn(`[AIGM] Blocked unreasonable CPU→human offer from ${cpuTeam}`);
      return;
    }

    const offerId = generateOfferId();
    const offer: CPUOffer = {
      id: offerId,
      proposerTeam: cpuTeam,
      receiverTeam: idea.partnerTeam,
      offeredOveralls: idea.offeredOveralls,
      requestedOveralls: idea.requestedOveralls,
      offeredFuturePicks: idea.offeredFuturePicks,
      requestedFuturePicks: idea.requestedFuturePicks,
      offeredPlayers: idea.offeredPlayers,
      requestedPlayers: idea.requestedPlayers,
      pitch: idea.pitch,
      createdAt: Date.now(),
      isCounter: false,
    };
    this.pendingCPUOffers.set(offerId, offer);

    this.host.emit('cpu-offer:sent', { offer });
  }

  /** Handle a human clicking Accept on a CPU offer. */
  async handleOfferAccept(offerId: string, userId: string): Promise<{ success: boolean; error?: string }> {
    const offer = this.pendingCPUOffers.get(offerId);
    if (!offer) return { success: false, error: 'This offer has expired or was already handled.' };

    const state = this.host.getState();
    if (!this.isAuthorizedForTeam(userId, offer.receiverTeam, state)) {
      return { success: false, error: 'You are not the GM of the receiving team.' };
    }

    const trade = this.offerToTrade(offer);
    const result = await this.host.getTradeManager().executeCPUTrade(trade);
    this.pendingCPUOffers.delete(offerId);
    this.host.emit('cpu-offer:resolved', { offerId, accepted: true });
    return result;
  }

  /** Handle a human clicking Decline on a CPU offer. */
  async handleOfferDecline(offerId: string, userId: string): Promise<{ success: boolean; error?: string }> {
    const offer = this.pendingCPUOffers.get(offerId);
    if (!offer) return { success: false, error: 'This offer has expired or was already handled.' };

    const state = this.host.getState();
    if (!this.isAuthorizedForTeam(userId, offer.receiverTeam, state)) {
      return { success: false, error: 'You are not the GM of the receiving team.' };
    }

    this.host.getTradeManager().recordCancelledTrade(this.offerToTrade(offer), 'declined');
    this.pendingCPUOffers.delete(offerId);
    this.host.emit('cpu-offer:resolved', { offerId, accepted: false });
    return { success: true };
  }

  // ── CPU offer invalidation ─────────────────────────────────────────────

  /** Remove CPU offers that reference a pick that was just made. */
  invalidateOffersForPick(overall: number): void {
    for (const [id, offer] of this.pendingCPUOffers) {
      if (offer.offeredOveralls.includes(overall) || offer.requestedOveralls.includes(overall)) {
        console.log(`[AIGM] Invalidating CPU offer ${id} (pick #${overall} was made)`);
        this.pendingCPUOffers.delete(id);
        this.host.emit('cpu-offer:resolved', { offerId: id, accepted: false });
      }
    }
  }

  /** Remove CPU offers that overlap with an executed trade's assets. */
  invalidateSupersededOffers(trade: PendingTrade): void {
    const involvedPicks = new Set([...trade.offeredOveralls, ...trade.requestedOveralls]);
    const involvedPlayers = new Set(
      [...trade.offeredPlayers, ...trade.requestedPlayers].map(p => p.toLowerCase()),
    );
    for (const [id, offer] of this.pendingCPUOffers) {
      const overlaps =
        offer.offeredOveralls.some(o => involvedPicks.has(o)) ||
        offer.requestedOveralls.some(o => involvedPicks.has(o)) ||
        offer.offeredPlayers.some(p => involvedPlayers.has(p.toLowerCase())) ||
        offer.requestedPlayers.some(p => involvedPlayers.has(p.toLowerCase()));
      if (overlaps) {
        console.log(`[AIGM] Invalidating CPU offer ${id} (superseded by trade)`);
        this.pendingCPUOffers.delete(id);
        this.host.emit('cpu-offer:resolved', { offerId: id, accepted: false });
      }
    }
  }

  // ── Trade idea validation ──────────────────────────────────────────────

  /** Returns null if valid, or a reason string if invalid. */
  private validateTradeIdea(
    proposerTeam: string,
    idea: TradeIdea,
    state: Readonly<DraftState>,
  ): string | null {
    // Both sides must have at least one asset
    const totalOffered = idea.offeredOveralls.length + idea.offeredFuturePicks.length + idea.offeredPlayers.length;
    const totalRequested = idea.requestedOveralls.length + idea.requestedFuturePicks.length + idea.requestedPlayers.length;
    if (totalOffered === 0 || totalRequested === 0) {
      return `empty side: offered=${totalOffered} requested=${totalRequested}`;
    }

    // Validate pick ownership
    const remaining = state.schedule.slice(state.currentPickIndex);
    for (const o of idea.offeredOveralls) {
      const slot = remaining.find(s => s.overall === o);
      if (!slot || slot.currentTeam !== proposerTeam) {
        return `${proposerTeam} doesn't own pick #${o}`;
      }
    }
    for (const o of idea.requestedOveralls) {
      const slot = remaining.find(s => s.overall === o);
      if (!slot || slot.currentTeam !== idea.partnerTeam) {
        return `${idea.partnerTeam} doesn't own pick #${o}`;
      }
    }

    // Validate future pick ownership
    for (const fpId of idea.offeredFuturePicks) {
      const fp = state.futurePickRights.find(f => f.id === fpId);
      if (!fp || fp.currentTeam !== proposerTeam) {
        return `${proposerTeam} doesn't own future pick ${fpId}`;
      }
    }
    for (const fpId of idea.requestedFuturePicks) {
      const fp = state.futurePickRights.find(f => f.id === fpId);
      if (!fp || fp.currentTeam !== idea.partnerTeam) {
        return `${idea.partnerTeam} doesn't own future pick ${fpId}`;
      }
    }

    return null;
  }

  // ── CPU → CPU trades ──────────────────────────────────────────────────

  private async attemptCPUToCPUTrade(
    proposerTeam: string,
    idea: TradeIdea,
    state: Readonly<DraftState>,
  ): Promise<boolean> {
    if (state.assignments[idea.partnerTeam]) return false; // partner is human

    // Validate both sides have assets and pick ownership
    const ownershipCheck = this.validateTradeIdea(proposerTeam, idea, state);
    if (ownershipCheck) {
      console.warn(`[AIGM] Blocked CPU↔CPU trade ${proposerTeam} → ${idea.partnerTeam}: ${ownershipCheck}`);
      return false;
    }

    const futurePicks = state.futurePickRights;
    const offeredFuture = idea.offeredFuturePicks
      .map(id => futurePicks.find(f => f.id === id))
      .filter((f): f is FuturePickRight => !!f)
      .map(f => ({ year: f.year, round: f.round }));
    const requestedFuture = idea.requestedFuturePicks
      .map(id => futurePicks.find(f => f.id === id))
      .filter((f): f is FuturePickRight => !!f)
      .map(f => ({ year: f.year, round: f.round }));

    const hasPicksOrFuture = idea.offeredOveralls.length > 0 || idea.requestedOveralls.length > 0
      || offeredFuture.length > 0 || requestedFuture.length > 0;

    if (hasPicksOrFuture && !isTradeReasonable(idea.offeredOveralls, idea.requestedOveralls, offeredFuture, requestedFuture)) {
      console.warn(`[AIGM] Blocked unreasonable CPU↔CPU trade: ${proposerTeam} → ${idea.partnerTeam}`);
      return false;
    }

    const receiverProfile = getGMProfile(idea.partnerTeam);
    const receiverCtx = this.buildContext(idea.partnerTeam, state);

    const evaluation = await evaluateIncomingTrade(receiverProfile, receiverCtx, {
      fromTeam: proposerTeam,
      offeredOveralls: idea.offeredOveralls,
      requestedOveralls: idea.requestedOveralls,
      offeredFuturePicks: idea.offeredFuturePicks,
      requestedFuturePicks: idea.requestedFuturePicks,
      offeredPlayers: idea.offeredPlayers,
      requestedPlayers: idea.requestedPlayers,
    });

    if (!evaluation) return false;

    if (evaluation.decision === 'accept') {
      const trade = this.buildTrade(proposerTeam, idea);
      const result = await this.host.getTradeManager().executeCPUTrade(trade);
      if (result.success) {
        console.log(`[AIGM] CPU↔CPU trade executed: ${proposerTeam} ↔ ${idea.partnerTeam}`);
        this.lastTradeTime.set(proposerTeam, Date.now());
        this.lastTradeTime.set(idea.partnerTeam, Date.now());
        return true;
      }
      console.warn(`[AIGM] CPU↔CPU trade failed: ${result.error}`);
      return false;
    }

    if (evaluation.decision === 'counter' && evaluation.counterOffer) {
      this.emitChatter(proposerTeam, idea.partnerTeam, 'counter', evaluation.reasoning);
      return this.handleCPUCounter(proposerTeam, idea.partnerTeam, evaluation, state);
    }

    this.emitChatter(proposerTeam, idea.partnerTeam, 'declined', evaluation.reasoning);
    this.host.getTradeManager().recordCancelledTrade(this.buildTrade(proposerTeam, idea), 'declined');
    return false;
  }

  private async handleCPUCounter(
    originalProposer: string,
    counterTeam: string,
    evaluation: TradeEvaluation,
    state: Readonly<DraftState>,
  ): Promise<boolean> {
    if (!evaluation.counterOffer) return false;
    const counter = evaluation.counterOffer;

    // Resolve LLM future pick references in counter-offer
    counter.offeredFuturePicks = this.resolveFuturePicks(counter.offeredFuturePicks, counterTeam, state);
    counter.requestedFuturePicks = this.resolveFuturePicks(counter.requestedFuturePicks, originalProposer, state);

    // Validate counter-offer ownership and non-empty sides
    const counterIdea: TradeIdea = {
      partnerTeam: originalProposer,
      offeredOveralls: counter.offeredOveralls,
      requestedOveralls: counter.requestedOveralls,
      offeredFuturePicks: counter.offeredFuturePicks,
      requestedFuturePicks: counter.requestedFuturePicks,
      offeredPlayers: counter.offeredPlayers ?? [],
      requestedPlayers: counter.requestedPlayers ?? [],
      pitch: '',
    };
    const counterCheck = this.validateTradeIdea(counterTeam, counterIdea, state);
    if (counterCheck) {
      console.warn(`[AIGM] Blocked counter-offer ${counterTeam} → ${originalProposer}: ${counterCheck}`);
      return false;
    }

    const futurePicks = state.futurePickRights;
    const offeredFuture = counter.offeredFuturePicks
      .map(id => futurePicks.find(f => f.id === id))
      .filter((f): f is FuturePickRight => !!f)
      .map(f => ({ year: f.year, round: f.round }));
    const requestedFuture = counter.requestedFuturePicks
      .map(id => futurePicks.find(f => f.id === id))
      .filter((f): f is FuturePickRight => !!f)
      .map(f => ({ year: f.year, round: f.round }));

    if (!isTradeReasonable(counter.offeredOveralls, counter.requestedOveralls, offeredFuture, requestedFuture)) {
      return false;
    }

    const proposerProfile = getGMProfile(originalProposer);
    const proposerCtx = this.buildContext(originalProposer, state);

    const response = await evaluateIncomingTrade(proposerProfile, proposerCtx, {
      fromTeam: counterTeam,
      offeredOveralls: counter.offeredOveralls,
      requestedOveralls: counter.requestedOveralls,
      offeredFuturePicks: counter.offeredFuturePicks,
      requestedFuturePicks: counter.requestedFuturePicks,
      offeredPlayers: counter.offeredPlayers ?? [],
      requestedPlayers: counter.requestedPlayers ?? [],
    });

    if (response?.decision === 'accept') {
      const trade: PendingTrade = {
        id: generateOfferId(),
        proposerUserId: 'cpu',
        proposerTeam: counterTeam,
        receiverUserId: 'cpu',
        receiverTeam: originalProposer,
        offeredOveralls: counter.offeredOveralls,
        requestedOveralls: counter.requestedOveralls,
        offeredPlayers: counter.offeredPlayers ?? [],
        requestedPlayers: counter.requestedPlayers ?? [],
        offeredFuturePicks: counter.offeredFuturePicks,
        requestedFuturePicks: counter.requestedFuturePicks,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      const result = await this.host.getTradeManager().executeCPUTrade(trade);
      if (result.success) {
        console.log(`[AIGM] CPU counter-trade executed: ${counterTeam} ↔ ${originalProposer}`);
        this.lastTradeTime.set(counterTeam, Date.now());
        this.lastTradeTime.set(originalProposer, Date.now());
        return true;
      }
    }

    if (response) {
      this.emitChatter(counterTeam, originalProposer, 'counter-declined', response.reasoning);
    }
    return false;
  }

  // ── Human → CPU trade routing ─────────────────────────────────────────

  async evaluateHumanProposal(trade: PendingTrade): Promise<TradeEvaluation | null> {
    if (!this.isEnabled() || !isOllamaConfigured()) return null;

    const state = this.host.getState();
    const profile = getGMProfile(trade.receiverTeam);
    const ctx = this.buildContext(trade.receiverTeam, state);

    const proposal = {
      fromTeam: trade.proposerTeam,
      offeredOveralls: trade.offeredOveralls,
      requestedOveralls: trade.requestedOveralls,
      offeredFuturePicks: trade.offeredFuturePicks,
      requestedFuturePicks: trade.requestedFuturePicks,
      offeredPlayers: trade.offeredPlayers,
      requestedPlayers: trade.requestedPlayers,
    };

    const result = await evaluateIncomingTrade(profile, ctx, proposal, true);
    if (result) return result;

    console.warn(`[AIGM] First evaluateHumanProposal attempt failed for ${trade.receiverTeam}, retrying...`);
    return evaluateIncomingTrade(profile, ctx, proposal, true);
  }

  // ── Trade chatter ─────────────────────────────────────────────────────

  private emitChatter(
    team1: string,
    team2: string,
    outcome: string,
    reasoning: string,
  ): void {
    const name1 = TEAMS[team1]?.name ?? team1;
    const name2 = TEAMS[team2]?.name ?? team2;

    const phrases: Record<string, string[]> = {
      negotiating: [
        `**${name1}** is working the phones with **${name2}**...`,
        `Trade talks heating up between **${name1}** and **${name2}**.`,
        `**${name1}** has called **${name2}** about a deal.`,
      ],
      declined: [
        `**${name2}** hung up the phone on **${name1}**.`,
        `**${name1}** called **${name2}** about a trade — no deal.`,
        `**${name2}** passed on a trade offer from **${name1}**.`,
        `Trade talks between **${name1}** and **${name2}** went nowhere.`,
      ],
      counter: [
        `**${name2}** countered **${name1}**'s offer — negotiations ongoing.`,
        `**${name1}** and **${name2}** are going back and forth on a deal.`,
      ],
      'counter-declined': [
        `**${name1}** and **${name2}** couldn't close — counter rejected.`,
        `Trade talks between **${name1}** and **${name2}** fell apart after a counter-offer.`,
      ],
      executed: [
        `**TRADE!** **${name1}** and **${name2}** have struck a deal!`,
        `**BREAKING:** **${name1}** and **${name2}** complete a trade.`,
      ],
    };

    const options = phrases[outcome] ?? phrases.declined;
    const headline = options[Math.floor(Math.random() * options.length)];

    try {
      this.host.emit('trade:chatter', { team1: name1, team2: name2, outcome, reasoning: `${headline}\n> *${reasoning.slice(0, 200)}*` });
    } catch { /* non-critical */ }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Resolve LLM-returned future pick references into real FuturePickRight IDs.
   * The LLM may return bare years ("2027"), partial ("2027-R1"), or full IDs ("2027-R1-PHI").
   * We match against the team's actual future pick rights.
   */
  private resolveFuturePicks(raw: string[], teamAbbr: string, state: Readonly<DraftState>): string[] {
    const teamRights = state.futurePickRights.filter(f => f.currentTeam === teamAbbr);
    const resolved: string[] = [];
    const used = new Set<string>();

    for (const val of raw) {
      const s = String(val);

      // Already a valid ID?
      const exact = teamRights.find(f => f.id === s && !used.has(f.id));
      if (exact) { resolved.push(exact.id); used.add(exact.id); continue; }

      // Bare year (e.g. "2027" or 2027)
      const yearMatch = s.match(/^(\d{4})$/);
      if (yearMatch) {
        const year = parseInt(yearMatch[1]);
        const match = teamRights.find(f => f.year === year && !used.has(f.id));
        if (match) { resolved.push(match.id); used.add(match.id); continue; }
      }

      // Partial: "2027-R1" without team suffix
      const partialMatch = s.match(/^(\d{4})-R(\d)$/);
      if (partialMatch) {
        const year = parseInt(partialMatch[1]);
        const round = parseInt(partialMatch[2]);
        const match = teamRights.find(f => f.year === year && f.round === round && !used.has(f.id));
        if (match) { resolved.push(match.id); used.add(match.id); continue; }
      }

      // Couldn't resolve — skip it
      console.warn(`[AIGM] Could not resolve future pick "${s}" for ${teamAbbr}`);
    }

    return resolved;
  }

  private isEnabled(): boolean {
    return this.host.getState().config.cpuTrading;
  }

  private isAuthorizedForTeam(userId: string, teamAbbr: string, state: Readonly<DraftState>): boolean {
    return state.assignments[teamAbbr] === userId ||
      (state.coManagers[teamAbbr] ?? []).includes(userId);
  }

  private buildContext(teamAbbr: string, state: Readonly<DraftState>): TradeAIContext {
    const schedule = state.schedule;
    const currentIdx = state.currentPickIndex;

    const teamPicks = schedule
      .slice(currentIdx)
      .filter(s => s.currentTeam === teamAbbr)
      .map(s => ({ overall: s.overall, round: s.round }));

    const teamFuturePicks = state.futurePickRights
      .filter(f => f.currentTeam === teamAbbr)
      .map(f => ({ id: f.id, year: f.year, round: f.round }));

    const draftedByTeam = state.picks
      .filter(p => p.team === teamAbbr)
      .map(p => ({ name: p.prospectName, pos: p.pos }));

    const remainingSchedule = schedule
      .slice(currentIdx)
      .map(s => ({ overall: s.overall, round: s.round, currentTeam: s.currentTeam }));

    const strategyPrompt = this.host.getBoardData().strategyPrompts[teamAbbr]
      ?? DEFAULT_STRATEGY_PROMPTS[teamAbbr];

    // Active insider leaks relevant to this team
    const leaks = this.getActiveLeaks();
    const relevantLeaks = leaks
      .filter(l => l.mentionedTeams.includes(teamAbbr) || l.leakerTeam === teamAbbr || leaks.length <= 3)
      .map(l => l.tweet);

    return {
      teamAbbr,
      teamPicks,
      teamFuturePicks,
      availableRanks: [...state.availableRanks],
      draftedByTeam,
      currentPickIndex: currentIdx,
      totalPicks: schedule.length,
      remainingSchedule,
      strategyPrompt,
      tradeablePlayers: this.getTradeablePlayers(teamAbbr),
      recentLeaks: relevantLeaks,
    };
  }

  private buildTrade(proposerTeam: string, idea: TradeIdea): PendingTrade {
    return {
      id: generateOfferId(),
      proposerUserId: 'cpu',
      proposerTeam,
      receiverUserId: 'cpu',
      receiverTeam: idea.partnerTeam,
      offeredOveralls: idea.offeredOveralls,
      requestedOveralls: idea.requestedOveralls,
      offeredPlayers: idea.offeredPlayers,
      requestedPlayers: idea.requestedPlayers,
      offeredFuturePicks: idea.offeredFuturePicks,
      requestedFuturePicks: idea.requestedFuturePicks,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
  }

  private offerToTrade(offer: CPUOffer): PendingTrade {
    return {
      id: offer.id,
      proposerUserId: 'cpu',
      proposerTeam: offer.proposerTeam,
      receiverUserId: 'human',
      receiverTeam: offer.receiverTeam,
      offeredOveralls: offer.offeredOveralls,
      requestedOveralls: offer.requestedOveralls,
      offeredPlayers: offer.offeredPlayers,
      requestedPlayers: offer.requestedPlayers,
      offeredFuturePicks: offer.offeredFuturePicks,
      requestedFuturePicks: offer.requestedFuturePicks,
      createdAt: offer.createdAt,
      expiresAt: offer.createdAt + 120_000,
    };
  }

  private cleanExpiredOffers(): void {
    const now = Date.now();
    for (const [id, offer] of this.pendingCPUOffers) {
      if (now - offer.createdAt > 120_000) {
        this.host.getTradeManager().recordCancelledTrade(this.offerToTrade(offer), 'expired');
        this.pendingCPUOffers.delete(id);
      }
    }
  }

  private formatTradeIdea(team: string, idea: TradeIdea): string {
    const parts: string[] = [];
    if (idea.offeredOveralls.length) parts.push(`#${idea.offeredOveralls.join(', #')}`);
    if (idea.offeredPlayers.length) parts.push(idea.offeredPlayers.join(', '));
    if (idea.offeredFuturePicks.length) parts.push(idea.offeredFuturePicks.join(', '));
    const gives = parts.join(' + ') || 'nothing';

    const gets: string[] = [];
    if (idea.requestedOveralls.length) gets.push(`#${idea.requestedOveralls.join(', #')}`);
    if (idea.requestedPlayers.length) gets.push(idea.requestedPlayers.join(', '));
    if (idea.requestedFuturePicks.length) gets.push(idea.requestedFuturePicks.join(', '));
    const receives = gets.join(' + ') || 'nothing';

    return `${team} sends ${gives} to ${idea.partnerTeam} for ${receives}`;
  }

  private log(entry: Omit<TradeLogEntry, 'timestamp'>): void {
    if (this.tradeLog.length >= 2000) this.tradeLog.splice(0, 500);
    this.tradeLog.push({ timestamp: Date.now(), ...entry });
  }

  getPendingOffer(offerId: string): CPUOffer | undefined {
    return this.pendingCPUOffers.get(offerId);
  }
}

function generateOfferId(): string {
  return 'CPU-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
