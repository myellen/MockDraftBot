/**
 * AI GM Service — event-driven orchestrator for CPU trade agents.
 *
 * Reacts to draft events:
 *   onCPUTurn    — CPU is on the clock: decide whether to trade down or pick
 *   onHumanTurn  — human is on the clock: CPU GMs work phones in background
 *   onPickMade   — a pick was made: CPU GMs may react to falling prospects
 *
 * Proactive CPU→human offers use Discord embed buttons.
 * CPU↔CPU trades execute immediately via TradeManager.executeCPUTrade.
 *
 * All AI GM state is in-memory (pendingCPUOffers map). No persistence needed
 * since CPU offers don't survive restarts — they're ephemeral by design.
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel } from 'discord.js';
import type { DraftState, PendingTrade, PickSlot, FuturePickRight } from './types';
import type { TradeManager } from './TradeManager';
import { getGMProfile, type GMProfile } from '../data/gmProfiles';
import { TEAMS } from '../data/teams';
import { DEFAULT_STRATEGY_PROMPTS } from '../data/teamProfiles';
import { isTradeReasonable, getPickValue } from './tradeValue';
import {
  evaluateIncomingTrade,
  generateTradeIdea,
  decideOnClockTrade,
  type TradeAIContext,
  type TradeIdea,
  type TradeEvaluation,
} from '../llm/TradeAI';
import { isOllamaConfigured } from '../llm/OllamaService';

// ── Types ───────────────────────────────────────────────────────────────────

export interface CPUOffer {
  id: string;
  proposerTeam: string;
  receiverTeam: string;
  offeredOveralls: number[];
  requestedOveralls: number[];
  offeredFuturePicks: string[];
  requestedFuturePicks: string[];
  pitch: string;
  createdAt: number;
  isCounter: boolean;
  originalOfferId?: string;
}

interface AIGMHost {
  getState(): Readonly<DraftState>;
  getBoardData(): { strategyPrompts: Record<string, string> };
  getTradeManager(): TradeManager;
  sendToChannel(embed: EmbedBuilder, components?: ActionRowBuilder<ButtonBuilder>[]): Promise<void>;
}

// ── Rate limiting ───────────────────────────────────────────────────────────

const MIN_TRADE_INTERVAL_MS = 4_000;
const MAX_OFFERS_PER_PICK = 5;

// ── Service ─────────────────────────────────────────────────────────────────

export class AIGMService {
  private pendingCPUOffers = new Map<string, CPUOffer>();
  private lastTradeAttempt = new Map<string, number>();
  private offersThisPick = 0;

  constructor(private host: AIGMHost) {}

  // ── Event handlers ──────────────────────────────────────────────────────

  /**
   * CPU team is on the clock. Returns true if a trade was executed
   * (caller should NOT pick), false if caller should proceed with autopick.
   */
  async onCPUTurn(slot: PickSlot): Promise<boolean> {
    if (!this.isEnabled() || !isOllamaConfigured()) return false;

    const state = this.host.getState();
    const profile = getGMProfile(slot.currentTeam);
    const ctx = this.buildContext(slot.currentTeam, state);

    const decision = await decideOnClockTrade(profile, ctx, {
      overall: slot.overall,
      round: slot.round,
    });

    if (!decision || decision.action === 'pick') return false;
    if (!decision.tradeIdea) return false;

    // Attempt the trade
    const executed = await this.attemptCPUToCPUTrade(
      slot.currentTeam,
      decision.tradeIdea,
      state,
    );
    return executed;
  }

  /**
   * Human is on the clock. Fire-and-forget: CPU GMs work phones in background.
   */
  async onHumanTurn(slot: PickSlot): Promise<void> {
    if (!this.isEnabled() || !isOllamaConfigured()) return;
    this.offersThisPick = 0;

    // Pick a random CPU team to generate a trade idea
    const state = this.host.getState();
    const cpuTeams = this.getCPUTeams(state);
    if (cpuTeams.length === 0) return;

    // Shuffle and try up to 6 CPU teams
    const shuffled = cpuTeams.sort(() => Math.random() - 0.5).slice(0, 6);

    for (const teamAbbr of shuffled) {
      if (this.offersThisPick >= MAX_OFFERS_PER_PICK) break;
      if (this.isRateLimited(teamAbbr)) continue;

      const profile = getGMProfile(teamAbbr);
      const ctx = this.buildContext(teamAbbr, state);
      const idea = await generateTradeIdea(profile, ctx);
      if (!idea) continue;

      this.lastTradeAttempt.set(teamAbbr, Date.now());

      // Determine if the partner is human or CPU
      const partnerUserId = state.assignments[idea.partnerTeam];
      if (partnerUserId) {
        // CPU → Human: send Discord embed with buttons
        await this.sendCPUOfferToHuman(teamAbbr, idea, state);
      } else {
        // CPU → CPU: evaluate and execute
        await this.attemptCPUToCPUTrade(teamAbbr, idea, state);
      }
    }
  }

  /**
   * A pick was made. CPU GMs may react to sliding prospects.
   * Called after recordAndAnnounce.
   */
  async onPickMade(pick: { team: string; pos: string; prospectName: string }): Promise<void> {
    // Expire any CPU offers involving picks that are now gone
    this.cleanExpiredOffers();
  }

  // ── CPU → Human offers (Discord buttons) ──────────────────────────────

  private async sendCPUOfferToHuman(
    cpuTeam: string,
    idea: TradeIdea,
    state: Readonly<DraftState>,
  ): Promise<void> {
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

    if (!isTradeReasonable(idea.offeredOveralls, idea.requestedOveralls, offeredFuture, requestedFuture)) {
      console.warn(`[AIGMService] Blocked unreasonable CPU→human offer from ${cpuTeam}`);
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
      pitch: idea.pitch,
      createdAt: Date.now(),
      isCounter: false,
    };
    this.pendingCPUOffers.set(offerId, offer);
    this.offersThisPick++;

    const embed = this.buildOfferEmbed(offer, state);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`cpu-offer-accept:${offerId}`)
        .setLabel('Accept Trade')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`cpu-offer-decline:${offerId}`)
        .setLabel('Decline')
        .setStyle(ButtonStyle.Danger),
    );

    await this.host.sendToChannel(embed, [row]);
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

    this.pendingCPUOffers.delete(offerId);
    return { success: true };
  }

  // ── CPU → CPU trades ──────────────────────────────────────────────────

  private async attemptCPUToCPUTrade(
    proposerTeam: string,
    idea: TradeIdea,
    state: Readonly<DraftState>,
  ): Promise<boolean> {
    // Partner must be CPU
    const partnerUserId = state.assignments[idea.partnerTeam];
    if (partnerUserId) return false; // partner is human

    // Hard guardrail
    const futurePicks = state.futurePickRights;
    const offeredFuture = idea.offeredFuturePicks
      .map(id => futurePicks.find(f => f.id === id))
      .filter((f): f is FuturePickRight => !!f)
      .map(f => ({ year: f.year, round: f.round }));
    const requestedFuture = idea.requestedFuturePicks
      .map(id => futurePicks.find(f => f.id === id))
      .filter((f): f is FuturePickRight => !!f)
      .map(f => ({ year: f.year, round: f.round }));

    if (!isTradeReasonable(idea.offeredOveralls, idea.requestedOveralls, offeredFuture, requestedFuture)) {
      console.warn(`[AIGMService] Blocked unreasonable CPU↔CPU trade: ${proposerTeam} → ${idea.partnerTeam}`);
      return false;
    }

    // Ask the receiving GM to evaluate
    const receiverProfile = getGMProfile(idea.partnerTeam);
    const receiverCtx = this.buildContext(idea.partnerTeam, state);

    const evaluation = await evaluateIncomingTrade(receiverProfile, receiverCtx, {
      fromTeam: proposerTeam,
      offeredOveralls: idea.offeredOveralls,
      requestedOveralls: idea.requestedOveralls,
      offeredFuturePicks: idea.offeredFuturePicks,
      requestedFuturePicks: idea.requestedFuturePicks,
    });

    if (!evaluation) return false;

    const proposerName = TEAMS[proposerTeam]?.name ?? proposerTeam;
    const receiverName = TEAMS[idea.partnerTeam]?.name ?? idea.partnerTeam;

    if (evaluation.decision === 'accept') {
      const trade = this.buildTrade(proposerTeam, idea);
      const result = await this.host.getTradeManager().executeCPUTrade(trade);
      if (result.success) {
        console.log(`[AIGMService] CPU↔CPU trade executed: ${proposerTeam} ↔ ${idea.partnerTeam}`);
        return true;
      }
      console.warn(`[AIGMService] CPU↔CPU trade failed: ${result.error}`);
      return false;
    }

    if (evaluation.decision === 'counter' && evaluation.counterOffer) {
      // Announce the counter attempt
      void this.announceTradeChatter(proposerName, receiverName, 'counter', evaluation.reasoning);
      return this.handleCPUCounter(proposerTeam, idea.partnerTeam, evaluation, state);
    }

    // Declined — announce it
    void this.announceTradeChatter(proposerName, receiverName, 'declined', evaluation.reasoning);
    return false;
  }

  private async handleCPUCounter(
    originalProposer: string,
    counterTeam: string,
    evaluation: TradeEvaluation,
    state: Readonly<DraftState>,
  ): Promise<boolean> {
    if (!evaluation.counterOffer) return false;

    // Max 1 counter per negotiation
    const counter = evaluation.counterOffer;

    // Hard guardrail on counter
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

    // Ask the original proposer to evaluate the counter (no further counters)
    const proposerProfile = getGMProfile(originalProposer);
    const proposerCtx = this.buildContext(originalProposer, state);

    const response = await evaluateIncomingTrade(proposerProfile, proposerCtx, {
      fromTeam: counterTeam,
      offeredOveralls: counter.offeredOveralls,
      requestedOveralls: counter.requestedOveralls,
      offeredFuturePicks: counter.offeredFuturePicks,
      requestedFuturePicks: counter.requestedFuturePicks,
    });

    const proposerName = TEAMS[originalProposer]?.name ?? originalProposer;
    const counterName = TEAMS[counterTeam]?.name ?? counterTeam;

    if (response?.decision === 'accept') {
      // Counter is from counterTeam's perspective: offered = what counterTeam gives
      const trade: PendingTrade = {
        id: generateOfferId(),
        proposerUserId: 'cpu',
        proposerTeam: counterTeam,
        receiverUserId: 'cpu',
        receiverTeam: originalProposer,
        offeredOveralls: counter.offeredOveralls,
        requestedOveralls: counter.requestedOveralls,
        offeredPlayers: [],
        requestedPlayers: [],
        offeredFuturePicks: counter.offeredFuturePicks,
        requestedFuturePicks: counter.requestedFuturePicks,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      const result = await this.host.getTradeManager().executeCPUTrade(trade);
      if (result.success) {
        console.log(`[AIGMService] CPU counter-trade executed: ${counterTeam} ↔ ${originalProposer}`);
        return true;
      }
    }

    // Counter was declined by original proposer
    if (response) {
      void this.announceTradeChatter(counterName, proposerName, 'counter-declined', response.reasoning);
    }
    return false;
  }

  // ── Human → CPU trade routing ─────────────────────────────────────────

  /**
   * A human proposed a trade to a CPU team.
   * Evaluate and respond (accept/decline/counter).
   */
  async evaluateHumanProposal(trade: PendingTrade): Promise<TradeEvaluation | null> {
    if (!this.isEnabled() || !isOllamaConfigured()) return null;

    const state = this.host.getState();
    const profile = getGMProfile(trade.receiverTeam);
    const ctx = this.buildContext(trade.receiverTeam, state);

    return evaluateIncomingTrade(profile, ctx, {
      fromTeam: trade.proposerTeam,
      offeredOveralls: trade.offeredOveralls,
      requestedOveralls: trade.requestedOveralls,
      offeredFuturePicks: trade.offeredFuturePicks,
      requestedFuturePicks: trade.requestedFuturePicks,
    });
  }

  // ── Trade chatter announcements ────────────────────────────────────

  private async announceTradeChatter(
    team1: string,
    team2: string,
    outcome: 'declined' | 'counter' | 'counter-declined',
    reasoning: string,
  ): Promise<void> {
    const phrases: Record<string, string[]> = {
      declined: [
        `**${team2}** hung up the phone on **${team1}**.`,
        `**${team1}** called **${team2}** about a trade — no deal.`,
        `**${team2}** passed on a trade offer from **${team1}**.`,
        `**${team1}** pitched a deal to **${team2}** — shot down.`,
        `Trade talks between **${team1}** and **${team2}** went nowhere.`,
      ],
      counter: [
        `**${team2}** countered **${team1}**'s offer — negotiations ongoing.`,
        `**${team1}** and **${team2}** are going back and forth on a deal.`,
        `**${team2}** liked the idea but sent a counter to **${team1}**.`,
      ],
      'counter-declined': [
        `**${team1}** and **${team2}** couldn't close — counter rejected.`,
        `Trade talks between **${team1}** and **${team2}** fell apart after a counter-offer.`,
        `**${team2}** countered, but **${team1}** walked away.`,
      ],
    };

    const options = phrases[outcome] ?? phrases.declined;
    const headline = options[Math.floor(Math.random() * options.length)];

    const embed = new EmbedBuilder()
      .setDescription(`${headline}\n> *${reasoning.slice(0, 200)}*`)
      .setColor(0x95a5a6)
      .setFooter({ text: 'Trade Market Chatter' });

    try {
      await this.host.sendToChannel(embed);
    } catch { /* non-critical */ }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private isEnabled(): boolean {
    return this.host.getState().config.cpuTrading;
  }

  private getCPUTeams(state: Readonly<DraftState>): string[] {
    const allTeams = Object.keys(TEAMS);
    return allTeams.filter(abbr => !state.assignments[abbr]);
  }

  private isRateLimited(teamAbbr: string): boolean {
    const last = this.lastTradeAttempt.get(teamAbbr);
    return !!last && Date.now() - last < MIN_TRADE_INTERVAL_MS;
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
      offeredPlayers: [],
      requestedPlayers: [],
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
      offeredPlayers: [],
      requestedPlayers: [],
      offeredFuturePicks: offer.offeredFuturePicks,
      requestedFuturePicks: offer.requestedFuturePicks,
      createdAt: offer.createdAt,
      expiresAt: offer.createdAt + 120_000,
    };
  }

  private buildOfferEmbed(offer: CPUOffer, state: Readonly<DraftState>): EmbedBuilder {
    const proposerName = TEAMS[offer.proposerTeam]?.name ?? offer.proposerTeam;
    const receiverName = TEAMS[offer.receiverTeam]?.name ?? offer.receiverTeam;
    const profile = getGMProfile(offer.proposerTeam);

    const offerLines: string[] = [];
    for (const o of offer.offeredOveralls) {
      const slot = state.schedule.find(s => s.overall === o);
      offerLines.push(`Pick #${o} (R${slot?.round ?? '?'}.${slot?.roundPick ?? '?'})`);
    }
    for (const id of offer.offeredFuturePicks) offerLines.push(id);

    const requestLines: string[] = [];
    for (const o of offer.requestedOveralls) {
      const slot = state.schedule.find(s => s.overall === o);
      requestLines.push(`Pick #${o} (R${slot?.round ?? '?'}.${slot?.roundPick ?? '?'})`);
    }
    for (const id of offer.requestedFuturePicks) requestLines.push(id);

    return new EmbedBuilder()
      .setTitle(`Trade Offer from ${proposerName}`)
      .setDescription(`*"${offer.pitch}"*`)
      .addFields(
        { name: `${proposerName} sends`, value: offerLines.join('\n') || 'Nothing', inline: true },
        { name: `${receiverName} sends`, value: requestLines.join('\n') || 'Nothing', inline: true },
      )
      .setColor(TEAMS[offer.proposerTeam]?.color ?? 0x888888)
      .setFooter({ text: `AI GM (${profile.archetype}) • Offer expires in 2 min` })
      .setTimestamp();
  }

  private cleanExpiredOffers(): void {
    const now = Date.now();
    for (const [id, offer] of this.pendingCPUOffers) {
      if (now - offer.createdAt > 120_000) {
        this.pendingCPUOffers.delete(id);
      }
    }
  }

  getPendingOffer(offerId: string): CPUOffer | undefined {
    return this.pendingCPUOffers.get(offerId);
  }
}

function generateOfferId(): string {
  return 'CPU-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}
