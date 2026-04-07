import { EmbedBuilder } from 'discord.js';
import {
  DraftState, PendingTrade, PlayerSalary, TeamCapInfo,
} from './types';
import { TEAMS } from '../data/teams';
import { ROSTERS } from '../data/rosters';
import { SALARIES, SALARY_CAP, ROOKIE_MINIMUM, getRookieCapHit } from '../data/salaries';
import { buildTradeExecutedEmbed } from '../utils/embeds';

// ─── Host interface ──────────────────────────────────────────────────────────

export interface TradeManagerHost {
  persist(): Promise<void>;
  sendEmbed(embed: EmbedBuilder, content?: string): Promise<void>;
  getUserTeam(userId: string): string | null;
  isAuthorizedForTeam(userId: string, teamAbbr: string): boolean;
  resolvePlayer(nameQuery: string, teamAbbr: string): string | null;
  clearTimer(): void;
  refreshClock(): Promise<void>;
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

// ─── TradeManager ────────────────────────────────────────────────────────────

export class TradeManager {
  constructor(
    private state: DraftState,
    private host: TradeManagerHost,
  ) {}

  // ─── Salary Cap ───────────────────────────────────────────────────────────

  /**
   * Look up the salary data for a player on a given team.
   * Checks the team's salary table first, then searches all teams if traded.
   */
  getPlayerSalary(playerName: string, teamAbbr: string): PlayerSalary | null {
    const key = playerName.toLowerCase();
    const teamSalaries = SALARIES[teamAbbr];
    if (teamSalaries?.[key]) return teamSalaries[key];
    for (const [, salaries] of Object.entries(SALARIES)) {
      if (salaries[key]) return salaries[key];
    }
    return null;
  }

  /**
   * Find the original team a player belongs to in the base SALARIES data.
   */
  private getPlayerOriginalSalaryTeam(playerName: string): string | null {
    const key = playerName.toLowerCase();
    for (const [abbr, salaries] of Object.entries(SALARIES)) {
      if (salaries[key]) return abbr;
    }
    return null;
  }

  /**
   * Compute a team's current salary cap situation, accounting for trades and draft picks.
   */
  getTeamCapInfo(teamAbbr: string): TeamCapInfo {
    let deadMoney = 0;
    const activeCharges: number[] = [];

    const teamSalaries = SALARIES[teamAbbr] ?? {};
    const baseRoster = ROSTERS[teamAbbr] ?? [];

    // 1. Process original roster players
    const rosterNames = new Set(baseRoster.map(p => p.name.toLowerCase()));
    for (const player of baseRoster) {
      const key = player.name.toLowerCase();
      const salary = teamSalaries[key];
      if (!salary) continue;

      const tradedTo = this.state.playerOwnership[key];
      if (tradedTo !== undefined && tradedTo !== teamAbbr) {
        deadMoney += salary.deadMoney;
      } else {
        activeCharges.push(salary.capHit);
      }
    }

    // 1b. Dead money from players NOT on the roster (voided/released/traded pre-draft)
    for (const [key, salary] of Object.entries(teamSalaries)) {
      if (rosterNames.has(key)) continue;
      deadMoney += salary.capHit;
    }

    // 2. Add players traded IN from other teams
    for (const [nameLower, ownerTeam] of Object.entries(this.state.playerOwnership)) {
      if (ownerTeam !== teamAbbr) continue;
      if (baseRoster.some(p => p.name.toLowerCase() === nameLower)) continue;

      const origTeam = this.getPlayerOriginalSalaryTeam(nameLower);
      if (!origTeam) continue;
      const origSalary = SALARIES[origTeam]?.[nameLower];
      if (!origSalary) continue;
      activeCharges.push(origSalary.baseSalary);
    }

    // 3. Add rookie cap hits for drafted players on this team
    for (const pick of this.state.picks) {
      if (pick.team === teamAbbr) {
        activeCharges.push(getRookieCapHit(pick.overall));
      }
    }

    // 4. Project undrafted picks this team owns (future rookie slot obligations)
    //    Per CBA Rule of 51: rookies are initially reserved at the minimum salary,
    //    so the NET cap impact of each pick = rookieSlotValue - minimum.
    let projectedRookieCap = 0;
    const futurePicks = this.state.schedule.slice(this.state.currentPickIndex);
    for (const slot of futurePicks) {
      if (slot.currentTeam === teamAbbr) {
        const rookieCost = getRookieCapHit(slot.overall);
        const netCost = Math.max(0, rookieCost - ROOKIE_MINIMUM);
        projectedRookieCap += netCost;
      }
    }

    // Top 51: sort descending, take the 51 highest active charges
    activeCharges.sort((a, b) => b - a);
    const top51Total = activeCharges.slice(0, 51).reduce((sum, c) => sum + c, 0);

    const capUsed = top51Total + deadMoney;
    const capSpace = SALARY_CAP - capUsed;

    return {
      capUsed,
      capSpace,
      deadMoney,
      projectedRookieCap,
      effectiveCapSpace: capSpace - projectedRookieCap,
    };
  }

  /**
   * Calculate the cap impact of a trade for both teams BEFORE execution.
   * Returns the cap space change for each team (negative = less space).
   *
   * Per CBA Art. 13 Sec. 6(f): new team takes on baseSalary (no signing bonus proration).
   * Per CBA Art. 7 Sec. 3(j): draft pick trades transfer the rookie slot obligation.
   */
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

    // ── Player cap impact ─────────────────────────────────────────────────────

    // Players proposer sends to receiver
    for (const name of trade.offeredPlayers) {
      const origTeam = this.getPlayerOriginalSalaryTeam(name.toLowerCase());
      if (!origTeam) continue;
      const salary = SALARIES[origTeam]?.[name.toLowerCase()];
      if (!salary) continue;

      const wasOriginallyOnProposer = origTeam === trade.proposerTeam;

      if (wasOriginallyOnProposer) {
        // Sender loses the capHit, keeps deadMoney; receiver takes on baseSalary (transferable cap)
        proposerCapDelta += salary.deadMoney - salary.capHit;
        receiverCapDelta -= salary.baseSalary;
      } else {
        // Player was traded to proposer previously — transferable is baseSalary
        proposerCapDelta += salary.baseSalary;
        receiverCapDelta -= salary.baseSalary;
      }
    }

    // Players receiver sends to proposer
    for (const name of trade.requestedPlayers) {
      const origTeam = this.getPlayerOriginalSalaryTeam(name.toLowerCase());
      if (!origTeam) continue;
      const salary = SALARIES[origTeam]?.[name.toLowerCase()];
      if (!salary) continue;

      const wasOriginallyOnReceiver = origTeam === trade.receiverTeam;

      if (wasOriginallyOnReceiver) {
        // Sender loses the capHit, keeps deadMoney; receiver takes on baseSalary
        receiverCapDelta += salary.deadMoney - salary.capHit;
        proposerCapDelta -= salary.baseSalary;
      } else {
        // Player was traded to receiver previously
        receiverCapDelta += salary.baseSalary;
        proposerCapDelta -= salary.baseSalary;
      }
    }

    // ── Draft pick cap impact ─────────────────────────────────────────────────
    // Per CBA Art. 7 Sec. 3(j): rookie slot obligation follows the pick.
    // Under Rule of 51, each pick is already reserved at ROOKIE_MINIMUM,
    // so the net cap delta is (rookieSlotValue - ROOKIE_MINIMUM).

    for (const overall of trade.offeredOveralls) {
      const netSlot = Math.max(0, getRookieCapHit(overall) - ROOKIE_MINIMUM);
      proposerCapDelta += netSlot;   // proposer sheds this obligation
      receiverCapDelta -= netSlot;   // receiver absorbs it
    }

    for (const overall of trade.requestedOveralls) {
      const netSlot = Math.max(0, getRookieCapHit(overall) - ROOKIE_MINIMUM);
      receiverCapDelta += netSlot;   // receiver sheds this obligation
      proposerCapDelta -= netSlot;   // proposer absorbs it
    }

    return {
      proposerCapChange: proposerCapDelta,
      receiverCapChange: receiverCapDelta,
      proposerNewSpace: proposerCap.effectiveCapSpace + proposerCapDelta,
      receiverNewSpace: receiverCap.effectiveCapSpace + receiverCapDelta,
    };
  }

  /**
   * Validate that a trade would not put either team over the salary cap.
   * Returns hard errors (cap exceeded) and soft warnings (dangerously low cap, high dead money).
   * Hard errors only enforced when enforceSalaryCap is enabled in config.
   * Warnings are always returned for informational display.
   */
  validateTradeCap(trade: PendingTrade): { valid: boolean; error?: string; warnings: string[] } {
    const warnings: string[] = [];
    const hasPlayerOrPickAssets = trade.offeredPlayers.length > 0 || trade.requestedPlayers.length > 0
      || trade.offeredOveralls.length > 0 || trade.requestedOveralls.length > 0;

    if (!hasPlayerOrPickAssets) return { valid: true, warnings };

    const impact = this.calculateTradeCapImpact(trade);

    // Hard fail: over the cap (only enforced when enforceSalaryCap is on)
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

    // Soft warnings (always computed, even when cap enforcement is off)
    const LOW_CAP_THRESHOLD = 3000; // $3M in thousands
    const DEAD_MONEY_RATIO = 0.25;  // 25% of cap

    for (const [team, newSpace] of [
      [trade.proposerTeam, impact.proposerNewSpace],
      [trade.receiverTeam, impact.receiverNewSpace],
    ] as const) {
      const teamName = TEAMS[team]?.name ?? team;

      if (newSpace >= 0 && newSpace < LOW_CAP_THRESHOLD) {
        warnings.push(`**${teamName}** would have only $${formatCapAmount(newSpace)} in effective cap space — may not be able to fill roster.`);
      }

      const capInfo = this.getTeamCapInfo(team);
      // Estimate new dead money: existing dead + any dead money added by this trade
      let addedDead = 0;
      const sentPlayers = team === trade.proposerTeam ? trade.offeredPlayers : trade.requestedPlayers;
      for (const name of sentPlayers) {
        const origTeam = this.getPlayerOriginalSalaryTeam(name.toLowerCase());
        if (origTeam === team) {
          const salary = SALARIES[origTeam]?.[name.toLowerCase()];
          if (salary) addedDead += salary.deadMoney;
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
    requestedFuturePickIds: string[] = []
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

    const receiverTeam = this.host.getUserTeam(receiverUserId);
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

    // Validate offered players belong to proposer
    const resolvedOfferedPlayers: string[] = [];
    for (const name of offeredPlayers) {
      const result = this.host.resolvePlayer(name, proposerTeam);
      if (!result) return { success: false, error: `Player "${name}" not found on the ${TEAMS[proposerTeam]?.name}.` };
      resolvedOfferedPlayers.push(result);
    }

    // Validate requested players belong to receiver
    const resolvedRequestedPlayers: string[] = [];
    for (const name of requestedPlayers) {
      const result = this.host.resolvePlayer(name, receiverTeam);
      if (!result) return { success: false, error: `Player "${name}" not found on the ${TEAMS[receiverTeam]?.name}.` };
      resolvedRequestedPlayers.push(result);
    }

    // Validate future pick rights
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

    // Validate salary cap implications
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

    // Re-validate salary cap at acceptance time
    const capCheck = this.validateTradeCap(trade);
    if (!capCheck.valid) return { success: false, error: capCheck.error };

    // Execute: swap currentTeam on the pick slots
    for (const overall of trade.offeredOveralls) {
      const slot = this.state.schedule.find(s => s.overall === overall)!;
      slot.currentTeam = trade.receiverTeam;
      if (!slot.isTraded) { slot.isTraded = true; }
    }
    for (const overall of trade.requestedOveralls) {
      const slot = this.state.schedule.find(s => s.overall === overall)!;
      slot.currentTeam = trade.proposerTeam;
      if (!slot.isTraded) { slot.isTraded = true; }
    }

    // Execute: transfer player ownership
    for (const name of trade.offeredPlayers) {
      this.state.playerOwnership[name.toLowerCase()] = trade.receiverTeam;
    }
    for (const name of trade.requestedPlayers) {
      this.state.playerOwnership[name.toLowerCase()] = trade.proposerTeam;
    }

    // Execute: transfer future pick rights
    for (const id of trade.offeredFuturePicks) {
      const right = this.state.futurePickRights.find(r => r.id === id);
      if (right) right.currentTeam = trade.receiverTeam;
    }
    for (const id of trade.requestedFuturePicks) {
      const right = this.state.futurePickRights.find(r => r.id === id);
      if (right) right.currentTeam = trade.proposerTeam;
    }

    // Save to history before removing
    this.state.tradeHistory.push(trade);

    // Remove this trade and cancel any overlapping pending trades
    const involved = new Set([...trade.offeredOveralls, ...trade.requestedOveralls]);
    this.state.pendingTrades = this.state.pendingTrades.filter(t =>
      t.id !== tradeId &&
      !t.offeredOveralls.some(o => involved.has(o)) &&
      !t.requestedOveralls.some(o => involved.has(o))
    );

    await this.host.persist();
    await this.host.sendEmbed(buildTradeExecutedEmbed(trade, TEAMS, this.state.schedule));

    // If the current pick was part of this trade, reset the clock for the new owner
    const currentSlot = this.state.schedule[this.state.currentPickIndex];
    if (currentSlot && involved.has(currentSlot.overall)) {
      this.host.clearTimer();
      await this.host.refreshClock();
    }

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

    this.state.pendingTrades = this.state.pendingTrades.filter(t => t.id !== tradeId);
    await this.host.persist();
    return { success: true };
  }

  async adminUndoTrade(tradeId: string): Promise<{ success: boolean; error?: string }> {
    const trade = this.state.tradeHistory.find(t => t.id === tradeId);
    if (!trade) return { success: false, error: 'Trade not found in history.' };

    // Reverse pick ownership
    for (const overall of trade.offeredOveralls) {
      const slot = this.state.schedule.find(s => s.overall === overall);
      if (slot) slot.currentTeam = trade.proposerTeam;
    }
    for (const overall of trade.requestedOveralls) {
      const slot = this.state.schedule.find(s => s.overall === overall);
      if (slot) slot.currentTeam = trade.receiverTeam;
    }

    // Reverse player ownership
    for (const name of trade.offeredPlayers) {
      this.state.playerOwnership[name.toLowerCase()] = trade.proposerTeam;
    }
    for (const name of trade.requestedPlayers) {
      this.state.playerOwnership[name.toLowerCase()] = trade.receiverTeam;
    }

    // Reverse future pick rights
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

    // Validate salary cap (even for admin — use /draft set-cap off to bypass)
    const capCheck = this.validateTradeCap(trade);
    if (!capCheck.valid) return { success: false, error: capCheck.error };

    // Execute immediately
    for (const overall of offeredOveralls) {
      const slot = this.state.schedule.find(s => s.overall === overall);
      if (slot) { slot.currentTeam = receiverTeam; slot.isTraded = true; }
    }
    for (const overall of requestedOveralls) {
      const slot = this.state.schedule.find(s => s.overall === overall);
      if (slot) { slot.currentTeam = proposerTeam; slot.isTraded = true; }
    }
    for (const name of offeredPlayers) {
      this.state.playerOwnership[name.toLowerCase()] = receiverTeam;
    }
    for (const name of requestedPlayers) {
      this.state.playerOwnership[name.toLowerCase()] = proposerTeam;
    }
    for (const id of offeredFuturePickIds) {
      const right = this.state.futurePickRights.find(r => r.id === id);
      if (right) right.currentTeam = receiverTeam;
    }
    for (const id of requestedFuturePickIds) {
      const right = this.state.futurePickRights.find(r => r.id === id);
      if (right) right.currentTeam = proposerTeam;
    }

    this.state.tradeHistory.push(trade);
    await this.host.persist();
    await this.host.sendEmbed(buildTradeExecutedEmbed(trade, TEAMS, this.state.schedule));

    const currentSlot = this.state.schedule[this.state.currentPickIndex];
    const involved = new Set([...offeredOveralls, ...requestedOveralls]);
    if (currentSlot && involved.has(currentSlot.overall)) {
      this.host.clearTimer();
      await this.host.refreshClock();
    }

    return { success: true, trade };
  }

  getTradeHistory(): PendingTrade[] {
    return this.state.tradeHistory;
  }

  isPickInPendingTrade(overall: number): boolean {
    return this.state.pendingTrades.some(t =>
      t.offeredOveralls.includes(overall) || t.requestedOveralls.includes(overall)
    );
  }

  private cleanExpiredTrades(): void {
    const now = Date.now();
    this.state.pendingTrades = this.state.pendingTrades.filter(t => t.expiresAt > now);
  }
}
