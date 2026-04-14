import {
  DraftState, PendingTrade, CancelledTrade, TeamCapInfo, TradeCancelReason,
} from './types';
import type { DraftEventMap } from './events';
import { TEAMS } from '../data/teams';
import { TEAM_CAP, TRADE_PLAYERS, TradePlayerValues } from '../data/capData';
import { SALARY_CAP, ROOKIE_MINIMUM, getRookieCapHit } from '../data/salaries';

// ─── Host interface ──────────────────────────────────────────────────────────

export interface TradeEngineHost {
  persist(): Promise<void>;
  getUserTeam(userId: string): string | null;
  isAuthorizedForTeam(userId: string, teamAbbr: string): boolean;
  resolvePlayer(nameQuery: string, teamAbbr: string): string | null;
  clearTimer(): void;
  refreshClock(): void;
  advanceIfIdle(): Promise<void>;
  emit<K extends keyof DraftEventMap>(event: K, data: DraftEventMap[K]): void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateTradeId(): string {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

/** Format a cap amount in thousands to a readable string (e.g. 12500 → "12.5M"). */
export function formatCapAmount(amountInThousands: number): string {
  const millions = amountInThousands / 1000;
  if (Math.abs(millions) >= 1) {
    return `${millions.toFixed(1).replace(/\.0$/, '')}M`;
  }
  return `${amountInThousands}K`;
}

// ─── TradeEngine ─────────────────────────────────────────────────────────────

export class TradeEngine {
  constructor(
    private state: DraftState,
    private host: TradeEngineHost,
  ) {}

  private cancelTrades(trades: PendingTrade[], reason: TradeCancelReason): void {
    const now = Date.now();
    for (const t of trades) {
      this.state.cancelledTrades.push({ ...t, cancelReason: reason, cancelledAt: now });
      this.host.emit('trade:cancelled', { trade: t, reason });
    }
  }

  /** Execute a trade: swap ownership, record history, emit event, refresh clock. */
  private async executeTradeSideEffects(trade: PendingTrade): Promise<void> {
    for (const overall of trade.offeredOveralls) {
      const slot = this.state.schedule.find(s => s.overall === overall);
      if (slot) { slot.currentTeam = trade.receiverTeam; slot.isTraded = true; }
    }
    for (const overall of trade.requestedOveralls) {
      const slot = this.state.schedule.find(s => s.overall === overall);
      if (slot) { slot.currentTeam = trade.proposerTeam; slot.isTraded = true; }
    }

    for (const name of trade.offeredPlayers) {
      this.state.playerOwnership[name.toLowerCase()] = trade.receiverTeam;
    }
    for (const name of trade.requestedPlayers) {
      this.state.playerOwnership[name.toLowerCase()] = trade.proposerTeam;
    }

    for (const id of trade.offeredFuturePicks) {
      const right = this.state.futurePickRights.find(r => r.id === id);
      if (right) right.currentTeam = trade.receiverTeam;
    }
    for (const id of trade.requestedFuturePicks) {
      const right = this.state.futurePickRights.find(r => r.id === id);
      if (right) right.currentTeam = trade.proposerTeam;
    }

    this.state.tradeHistory.push(trade);
    await this.host.persist();
    this.host.emit('trade:executed', { trade });

    const currentSlot = this.state.schedule[this.state.currentPickIndex];
    const involvedPicks = new Set([...trade.offeredOveralls, ...trade.requestedOveralls]);
    if (currentSlot && involvedPicks.has(currentSlot.overall)) {
      this.host.clearTimer();
      this.host.refreshClock();
      await this.host.advanceIfIdle();
    }
  }

  /** Cancel any pending human trades that overlap with an executed trade's assets. */
  private cancelSupersededPendingTrades(executedTrade: PendingTrade): void {
    const involvedPicks = new Set([...executedTrade.offeredOveralls, ...executedTrade.requestedOveralls]);
    const involvedPlayers = new Set(
      [...executedTrade.offeredPlayers, ...executedTrade.requestedPlayers].map(p => p.toLowerCase()),
    );
    const superseded = this.state.pendingTrades.filter(t =>
      t.id !== executedTrade.id && (
        t.offeredOveralls.some(o => involvedPicks.has(o)) ||
        t.requestedOveralls.some(o => involvedPicks.has(o)) ||
        t.offeredPlayers.some(p => involvedPlayers.has(p.toLowerCase())) ||
        t.requestedPlayers.some(p => involvedPlayers.has(p.toLowerCase()))
      )
    );
    this.cancelTrades(superseded, 'superseded');
    this.state.pendingTrades = this.state.pendingTrades.filter(t =>
      t.id !== executedTrade.id && !superseded.some(s => s.id === t.id)
    );
  }

  /**
   * Execute a pre-built trade from the AI GM system.
   * Validates pick availability and salary cap, cancels superseded human trades.
   */
  async executeCPUTrade(
    trade: PendingTrade,
  ): Promise<{ success: boolean; error?: string; trade?: PendingTrade }> {
    if (!this.state.config.allowPlayerTrades && (trade.offeredPlayers.length > 0 || trade.requestedPlayers.length > 0)) {
      return { success: false, error: 'Player trades are disabled.' };
    }

    const futurePicks = this.state.schedule.slice(this.state.currentPickIndex);
    for (const overall of trade.offeredOveralls) {
      const slot = futurePicks.find(s => s.overall === overall);
      if (!slot || slot.currentTeam !== trade.proposerTeam) {
        return { success: false, error: `Pick #${overall} is no longer available.` };
      }
    }
    for (const overall of trade.requestedOveralls) {
      const slot = futurePicks.find(s => s.overall === overall);
      if (!slot || slot.currentTeam !== trade.receiverTeam) {
        return { success: false, error: `Pick #${overall} is no longer available.` };
      }
    }

    const capCheck = this.validateTradeCap(trade);
    if (!capCheck.valid) return { success: false, error: capCheck.error };

    this.cancelSupersededPendingTrades(trade);
    await this.executeTradeSideEffects(trade);
    return { success: true, trade };
  }

  // ─── Salary Cap ───────────────────────────────────────────────────────────

  /**
   * Look up trade values for a player. Searches all teams in TRADE_PLAYERS.
   * Returns the values and the team abbreviation the player is keyed under.
   */
  private getTradePlayerValues(playerName: string): { values: TradePlayerValues; origTeam: string } | null {
    const key = playerName.toLowerCase();
    for (const [abbr, players] of Object.entries(TRADE_PLAYERS)) {
      if (players[key]) return { values: players[key], origTeam: abbr };
    }
    return null;
  }

  /**
   * Compute a team's current salary cap situation.
   */
  getTeamCapInfo(teamAbbr: string): TeamCapInfo {
    const baseline = TEAM_CAP[teamAbbr];
    if (!baseline) {
      return { capUsed: 0, capSpace: 0, deadMoney: 0, projectedRookieCap: 0, effectiveCapSpace: 0 };
    }

    let capSpaceAdj = baseline.capSpace;
    let deadMoney = baseline.deadMoney;

    for (const trade of this.state.tradeHistory) {
      const sentPlayers = trade.proposerTeam === teamAbbr ? trade.offeredPlayers
        : trade.receiverTeam === teamAbbr ? trade.requestedPlayers : [];
      for (const name of sentPlayers) {
        const pv = this.getTradePlayerValues(name.toLowerCase());
        if (!pv) continue;
        if (pv.origTeam === teamAbbr) {
          capSpaceAdj += pv.values.capHit - pv.values.deadCap;
          deadMoney += pv.values.deadCap;
        } else {
          capSpaceAdj += pv.values.incomingCap;
        }
      }

      const recvPlayers = trade.proposerTeam === teamAbbr ? trade.requestedPlayers
        : trade.receiverTeam === teamAbbr ? trade.offeredPlayers : [];
      for (const name of recvPlayers) {
        const pv = this.getTradePlayerValues(name.toLowerCase());
        if (!pv) continue;
        capSpaceAdj -= pv.values.incomingCap;
      }

      const sentPicks = trade.proposerTeam === teamAbbr ? trade.offeredOveralls
        : trade.receiverTeam === teamAbbr ? trade.requestedOveralls : [];
      for (const overall of sentPicks) {
        capSpaceAdj += Math.max(0, getRookieCapHit(overall) - ROOKIE_MINIMUM);
      }
      const recvPicks = trade.proposerTeam === teamAbbr ? trade.requestedOveralls
        : trade.receiverTeam === teamAbbr ? trade.offeredOveralls : [];
      for (const overall of recvPicks) {
        capSpaceAdj -= Math.max(0, getRookieCapHit(overall) - ROOKIE_MINIMUM);
      }
    }

    for (const pick of this.state.picks) {
      if (pick.team === teamAbbr) {
        capSpaceAdj -= getRookieCapHit(pick.overall);
      }
    }

    let projectedRookieCap = 0;
    const futurePicks = this.state.schedule.slice(this.state.currentPickIndex);
    for (const slot of futurePicks) {
      if (slot.currentTeam === teamAbbr) {
        const netCost = Math.max(0, getRookieCapHit(slot.overall) - ROOKIE_MINIMUM);
        projectedRookieCap += netCost;
      }
    }

    const capSpace = capSpaceAdj;
    const capUsed = SALARY_CAP - capSpace;

    return {
      capUsed,
      capSpace,
      deadMoney,
      projectedRookieCap,
      effectiveCapSpace: capSpace - projectedRookieCap,
    };
  }

  calculateTradeCapImpact(trade: PendingTrade): {
    proposerCapChange: number;
    receiverCapChange: number;
    proposerNewSpace: number;
    receiverNewSpace: number;
  } {
    const proposerCap = this.getTeamCapInfo(trade.proposerTeam);
    const receiverCap = this.getTeamCapInfo(trade.receiverTeam);

    let proposerCapDelta = 0;
    let receiverCapDelta = 0;

    for (const name of trade.offeredPlayers) {
      const pv = this.getTradePlayerValues(name.toLowerCase());
      if (!pv) continue;

      if (pv.origTeam === trade.proposerTeam) {
        proposerCapDelta += pv.values.capHit - pv.values.deadCap;
        receiverCapDelta -= pv.values.incomingCap;
      } else {
        proposerCapDelta += pv.values.incomingCap;
        receiverCapDelta -= pv.values.incomingCap;
      }
    }

    for (const name of trade.requestedPlayers) {
      const pv = this.getTradePlayerValues(name.toLowerCase());
      if (!pv) continue;

      if (pv.origTeam === trade.receiverTeam) {
        receiverCapDelta += pv.values.capHit - pv.values.deadCap;
        proposerCapDelta -= pv.values.incomingCap;
      } else {
        receiverCapDelta += pv.values.incomingCap;
        proposerCapDelta -= pv.values.incomingCap;
      }
    }

    for (const overall of trade.offeredOveralls) {
      const netSlot = Math.max(0, getRookieCapHit(overall) - ROOKIE_MINIMUM);
      proposerCapDelta += netSlot;
      receiverCapDelta -= netSlot;
    }
    for (const overall of trade.requestedOveralls) {
      const netSlot = Math.max(0, getRookieCapHit(overall) - ROOKIE_MINIMUM);
      receiverCapDelta += netSlot;
      proposerCapDelta -= netSlot;
    }

    return {
      proposerCapChange: proposerCapDelta,
      receiverCapChange: receiverCapDelta,
      proposerNewSpace: proposerCap.effectiveCapSpace + proposerCapDelta,
      receiverNewSpace: receiverCap.effectiveCapSpace + receiverCapDelta,
    };
  }

  validateTradeCap(trade: PendingTrade): { valid: boolean; error?: string; warnings: string[] } {
    const warnings: string[] = [];
    const hasPlayerOrPickAssets = trade.offeredPlayers.length > 0 || trade.requestedPlayers.length > 0
      || trade.offeredOveralls.length > 0 || trade.requestedOveralls.length > 0;

    if (!hasPlayerOrPickAssets) return { valid: true, warnings };

    const impact = this.calculateTradeCapImpact(trade);

    if (this.state.config.enforceSalaryCap) {
      if (impact.proposerNewSpace < 0) {
        const over = Math.abs(impact.proposerNewSpace);
        return {
          valid: false,
          error: `Trade would put the **${TEAMS[trade.proposerTeam]?.name ?? trade.proposerTeam}** $${formatCapAmount(over)} over the salary cap.`,
          warnings,
        };
      }
      if (impact.receiverNewSpace < 0) {
        const over = Math.abs(impact.receiverNewSpace);
        return {
          valid: false,
          error: `Trade would put the **${TEAMS[trade.receiverTeam]?.name ?? trade.receiverTeam}** $${formatCapAmount(over)} over the salary cap.`,
          warnings,
        };
      }
    }

    const LOW_CAP_THRESHOLD = 3000;
    const DEAD_MONEY_RATIO = 0.25;

    for (const [team, newSpace] of [
      [trade.proposerTeam, impact.proposerNewSpace],
      [trade.receiverTeam, impact.receiverNewSpace],
    ] as const) {
      const teamName = TEAMS[team]?.name ?? team;

      if (newSpace >= 0 && newSpace < LOW_CAP_THRESHOLD) {
        warnings.push(`**${teamName}** would have only $${formatCapAmount(newSpace)} in effective cap space — may not be able to fill roster.`);
      }

      const capInfo = this.getTeamCapInfo(team);
      let addedDead = 0;
      const sentPlayers = team === trade.proposerTeam ? trade.offeredPlayers : trade.requestedPlayers;
      for (const name of sentPlayers) {
        const pv = this.getTradePlayerValues(name.toLowerCase());
        if (pv && pv.origTeam === team) {
          addedDead += pv.values.deadCap;
        }
      }
      const projectedDead = capInfo.deadMoney + addedDead;
      if (projectedDead > SALARY_CAP * DEAD_MONEY_RATIO) {
        const pct = ((projectedDead / SALARY_CAP) * 100).toFixed(1);
        warnings.push(`**${teamName}** dead money would reach $${formatCapAmount(projectedDead)} (${pct}% of cap).`);
      }
    }

    return { valid: true, warnings };
  }

  // ─── Trades ───────────────────────────────────────────────────────────────

  getPendingTradesForUser(userId: string): PendingTrade[] {
    this.cleanExpiredTrades();
    const team = this.host.getUserTeam(userId);
    if (!team) return [];
    return this.state.pendingTrades.filter(t =>
      t.proposerTeam === team || t.receiverTeam === team
    );
  }

  async proposeTrade(
    proposerUserId: string,
    receiverUserId: string,
    offeredOveralls: number[],
    requestedOveralls: number[],
    offeredPlayers: string[] = [],
    requestedPlayers: string[] = [],
    offeredFuturePickIds: string[] = [],
    requestedFuturePickIds: string[] = [],
    receiverTeamOverride?: string,
  ): Promise<{ success: boolean; error?: string; trade?: PendingTrade }> {
    if (this.state.status !== 'active' && this.state.status !== 'paused') {
      return { success: false, error: 'No active draft.' };
    }
    if (!this.state.config.allowPlayerTrades && (offeredPlayers.length > 0 || requestedPlayers.length > 0)) {
      return { success: false, error: 'Player trades are disabled for this draft. Only picks can be traded.' };
    }
    if (offeredOveralls.length + offeredPlayers.length + offeredFuturePickIds.length === 0 ||
        requestedOveralls.length + requestedPlayers.length + requestedFuturePickIds.length === 0) {
      return { success: false, error: 'Must include at least one pick or player on each side.' };
    }

    const proposerTeam = this.host.getUserTeam(proposerUserId);
    if (!proposerTeam) return { success: false, error: 'You do not have a registered team.' };

    const receiverTeam = receiverTeamOverride ?? this.host.getUserTeam(receiverUserId);
    if (!receiverTeam) return { success: false, error: 'That user does not have a registered team.' };

    if (proposerTeam === receiverTeam) return { success: false, error: 'Cannot trade with yourself.' };

    this.cleanExpiredTrades();

    const futurePicks = this.state.schedule.slice(this.state.currentPickIndex);

    for (const overall of offeredOveralls) {
      const slot = futurePicks.find(s => s.overall === overall);
      if (!slot) return { success: false, error: `Pick #${overall} is not a future pick.` };
      if (slot.currentTeam !== proposerTeam) return { success: false, error: `Pick #${overall} does not belong to your team (${TEAMS[proposerTeam]?.name}).` };
    }

    for (const overall of requestedOveralls) {
      const slot = futurePicks.find(s => s.overall === overall);
      if (!slot) return { success: false, error: `Pick #${overall} is not a future pick.` };
      if (slot.currentTeam !== receiverTeam) return { success: false, error: `Pick #${overall} does not belong to ${TEAMS[receiverTeam]?.name}.` };
    }

    const resolvedOfferedPlayers: string[] = [];
    for (const name of offeredPlayers) {
      const result = this.host.resolvePlayer(name, proposerTeam);
      if (!result) return { success: false, error: `Player "${name}" not found on the ${TEAMS[proposerTeam]?.name}.` };
      resolvedOfferedPlayers.push(result);
    }

    const resolvedRequestedPlayers: string[] = [];
    for (const name of requestedPlayers) {
      const result = this.host.resolvePlayer(name, receiverTeam);
      if (!result) return { success: false, error: `Player "${name}" not found on the ${TEAMS[receiverTeam]?.name}.` };
      resolvedRequestedPlayers.push(result);
    }

    for (const id of offeredFuturePickIds) {
      const right = this.state.futurePickRights.find(r => r.id === id);
      if (!right) return { success: false, error: `Future pick "${id}" not found.` };
      if (right.currentTeam !== proposerTeam) return { success: false, error: `Future pick "${id}" does not belong to your team.` };
    }
    for (const id of requestedFuturePickIds) {
      const right = this.state.futurePickRights.find(r => r.id === id);
      if (!right) return { success: false, error: `Future pick "${id}" not found.` };
      if (right.currentTeam !== receiverTeam) return { success: false, error: `Future pick "${id}" does not belong to ${TEAMS[receiverTeam]?.name}.` };
    }

    const trade: PendingTrade = {
      id: generateTradeId(),
      proposerUserId,
      proposerTeam,
      receiverUserId,
      receiverTeam,
      offeredOveralls,
      requestedOveralls,
      offeredPlayers: resolvedOfferedPlayers,
      requestedPlayers: resolvedRequestedPlayers,
      offeredFuturePicks: offeredFuturePickIds,
      requestedFuturePicks: requestedFuturePickIds,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    };

    const capCheck = this.validateTradeCap(trade);
    if (!capCheck.valid) return { success: false, error: capCheck.error };

    this.state.pendingTrades.push(trade);
    await this.host.persist();
    return { success: true, trade };
  }

  async acceptTrade(
    userId: string,
    tradeId: string
  ): Promise<{ success: boolean; error?: string; trade?: PendingTrade }> {
    this.cleanExpiredTrades();

    const trade = this.state.pendingTrades.find(t => t.id === tradeId);
    if (!trade) return { success: false, error: 'Trade not found or expired.' };
    if (!this.host.isAuthorizedForTeam(userId, trade.receiverTeam)) return { success: false, error: 'This trade was not sent to you.' };

    const futurePicks = this.state.schedule.slice(this.state.currentPickIndex);

    for (const overall of trade.offeredOveralls) {
      const slot = futurePicks.find(s => s.overall === overall);
      if (!slot || slot.currentTeam !== trade.proposerTeam) {
        return { success: false, error: `Pick #${overall} is no longer available (may have been made or re-traded).` };
      }
    }
    for (const overall of trade.requestedOveralls) {
      const slot = futurePicks.find(s => s.overall === overall);
      if (!slot || slot.currentTeam !== trade.receiverTeam) {
        return { success: false, error: `Pick #${overall} is no longer available.` };
      }
    }

    const capCheck = this.validateTradeCap(trade);
    if (!capCheck.valid) return { success: false, error: capCheck.error };

    this.cancelSupersededPendingTrades(trade);
    await this.executeTradeSideEffects(trade);
    return { success: true, trade };
  }

  async declineTrade(
    userId: string,
    tradeId: string
  ): Promise<{ success: boolean; error?: string }> {
    const trade = this.state.pendingTrades.find(t => t.id === tradeId);
    if (!trade) return { success: false, error: 'Trade not found or expired.' };
    if (!this.host.isAuthorizedForTeam(userId, trade.proposerTeam) && !this.host.isAuthorizedForTeam(userId, trade.receiverTeam)) {
      return { success: false, error: 'You are not part of this trade.' };
    }

    this.cancelTrades([trade], 'declined');
    this.state.pendingTrades = this.state.pendingTrades.filter(t => t.id !== tradeId);
    await this.host.persist();
    return { success: true };
  }

  async adminUndoTrade(tradeId: string): Promise<{ success: boolean; error?: string }> {
    const trade = this.state.tradeHistory.find(t => t.id === tradeId);
    if (!trade) return { success: false, error: 'Trade not found in history.' };

    for (const overall of trade.offeredOveralls) {
      const slot = this.state.schedule.find(s => s.overall === overall);
      if (slot) slot.currentTeam = trade.proposerTeam;
    }
    for (const overall of trade.requestedOveralls) {
      const slot = this.state.schedule.find(s => s.overall === overall);
      if (slot) slot.currentTeam = trade.receiverTeam;
    }

    for (const name of trade.offeredPlayers) {
      this.state.playerOwnership[name.toLowerCase()] = trade.proposerTeam;
    }
    for (const name of trade.requestedPlayers) {
      this.state.playerOwnership[name.toLowerCase()] = trade.receiverTeam;
    }

    for (const id of trade.offeredFuturePicks) {
      const right = this.state.futurePickRights.find(r => r.id === id);
      if (right) right.currentTeam = trade.proposerTeam;
    }
    for (const id of trade.requestedFuturePicks) {
      const right = this.state.futurePickRights.find(r => r.id === id);
      if (right) right.currentTeam = trade.receiverTeam;
    }

    this.state.tradeHistory = this.state.tradeHistory.filter(t => t.id !== tradeId);
    await this.host.persist();
    return { success: true };
  }

  async adminForceTrade(
    proposerTeam: string,
    receiverTeam: string,
    offeredOveralls: number[],
    requestedOveralls: number[],
    offeredPlayers: string[],
    requestedPlayers: string[],
    offeredFuturePickIds: string[],
    requestedFuturePickIds: string[]
  ): Promise<{ success: boolean; error?: string; trade?: PendingTrade }> {
    if (!this.state.config.allowPlayerTrades && (offeredPlayers.length > 0 || requestedPlayers.length > 0)) {
      return { success: false, error: 'Player trades are disabled for this draft. Only picks can be traded.' };
    }
    const trade: PendingTrade = {
      id: generateTradeId(),
      proposerUserId: 'admin',
      proposerTeam,
      receiverUserId: 'admin',
      receiverTeam,
      offeredOveralls,
      requestedOveralls,
      offeredPlayers,
      requestedPlayers,
      offeredFuturePicks: offeredFuturePickIds,
      requestedFuturePicks: requestedFuturePickIds,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    };

    const capCheck = this.validateTradeCap(trade);
    if (!capCheck.valid) return { success: false, error: capCheck.error };

    await this.executeTradeSideEffects(trade);
    return { success: true, trade };
  }

  getTradeHistory(): PendingTrade[] {
    return this.state.tradeHistory;
  }

  getCancelledTrades(): CancelledTrade[] {
    return this.state.cancelledTrades;
  }

  /** Record a CPU trade decline/expiry so it appears in hit-rate stats. */
  recordCancelledTrade(trade: PendingTrade, reason: TradeCancelReason): void {
    this.state.cancelledTrades.push({ ...trade, cancelReason: reason, cancelledAt: Date.now() });
  }

  isPickInPendingTrade(overall: number): boolean {
    return this.state.pendingTrades.some(t =>
      t.offeredOveralls.includes(overall) || t.requestedOveralls.includes(overall)
    );
  }

  /** Remove any pending trades that include this pick (called after a pick is made). */
  invalidateTradesForPick(overall: number): void {
    const invalidated = this.state.pendingTrades.filter(t =>
      t.offeredOveralls.includes(overall) || t.requestedOveralls.includes(overall)
    );
    this.cancelTrades(invalidated, 'picked');
    this.state.pendingTrades = this.state.pendingTrades.filter(t =>
      !invalidated.some(inv => inv.id === t.id)
    );
  }

  private cleanExpiredTrades(): void {
    const now = Date.now();
    const expired = this.state.pendingTrades.filter(t => t.expiresAt <= now);
    this.cancelTrades(expired, 'expired');
    this.state.pendingTrades = this.state.pendingTrades.filter(t => t.expiresAt > now);
  }
}
