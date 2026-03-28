import { Client, TextChannel } from 'discord.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  DraftState, DraftStatus, DraftConfig, CompletedPick,
  PickSlot, PickResult, RegisterResult, PendingTrade, FuturePickRight
} from './types';
import { buildSchedule } from './scheduleBuilder';
import { FUTURE_PICK_TRADES } from '../data/draftOrder';
import { PROSPECTS_DEDUPED, PROSPECT_BY_RANK } from '../data/prospects';
import { TEAMS } from '../data/teams';
import { ROSTERS } from '../data/rosters';
import { buildPickEmbed, buildOnTheClockEmbed, buildDraftCompleteEmbed, buildTeamRosterEmbed, buildTradeExecutedEmbed } from '../utils/embeds';

const STATE_PATH = path.join(__dirname, '../../data/draft-state.json');

function buildFuturePickRights(): FuturePickRight[] {
  const rights: FuturePickRight[] = [];
  for (const year of [2027, 2028, 2029]) {
    for (const abbr of Object.keys(TEAMS)) {
      for (let round = 1; round <= 7; round++) {
        // Check if this pick was already traded before the draft started
        const trade = FUTURE_PICK_TRADES.find(
          t => t.year === year && t.round === round && t.originalTeam === abbr
        );
        rights.push({
          id: `${year}-R${round}-${abbr}`,
          year,
          round,
          originalTeam: abbr,
          currentTeam: trade ? trade.currentTeam : abbr,
        });
      }
    }
  }
  return rights;
}

const DEFAULT_STATE: DraftState = {
  schemaVersion: 1,
  status: 'idle',
  config: { channelId: null, timerSeconds: null, autoPick: true, rounds: 7 },
  assignments: {},
  coManagers: {},
  schedule: [],
  currentPickIndex: 0,
  picks: [],
  availableRanks: [],
  timerExpiresAt: null,
  pendingTrades: [],
  tradeHistory: [],
  playerOwnership: {},
  futurePickRights: buildFuturePickRights(),
};

export class DraftManager {
  private state: DraftState;
  private timerHandle: NodeJS.Timeout | null = null;
  private client: Client;

  private constructor(client: Client, state: DraftState) {
    this.client = client;
    this.state = state;
  }

  static async load(client: Client): Promise<DraftManager> {
    let state: DraftState;
    try {
      const raw = await fs.readFile(STATE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as DraftState;
      // Basic schema check
      if (parsed.schemaVersion !== 1) {
        console.warn('Draft state schema mismatch — resetting to default');
        state = { ...DEFAULT_STATE };
      } else {
        // Backfill fields added after initial schema
        const raw = parsed as unknown as Record<string, unknown>;
        state = {
          ...parsed,
          coManagers: (raw.coManagers as Record<string, string[]> | undefined) ?? {},
          pendingTrades: (raw.pendingTrades as PendingTrade[] | undefined) ?? [],
          tradeHistory: (raw.tradeHistory as PendingTrade[] | undefined) ?? [],
          playerOwnership: (raw.playerOwnership as Record<string, string> | undefined) ?? {},
          futurePickRights: (raw.futurePickRights as FuturePickRight[] | undefined) ?? buildFuturePickRights(),
          config: { ...(parsed.config as DraftConfig), rounds: (parsed.config as DraftConfig).rounds ?? 7 },
        };
        // Backfill arrays on existing trades
        state.pendingTrades = state.pendingTrades.map(t => {
          const rt = t as unknown as Record<string, unknown>;
          return {
            ...t,
            offeredPlayers: (rt.offeredPlayers as string[] | undefined) ?? [],
            requestedPlayers: (rt.requestedPlayers as string[] | undefined) ?? [],
            offeredFuturePicks: (rt.offeredFuturePicks as string[] | undefined) ?? [],
            requestedFuturePicks: (rt.requestedFuturePicks as string[] | undefined) ?? [],
          };
        });
      }
    } catch {
      state = { ...DEFAULT_STATE };
    }

    const manager = new DraftManager(client, state);

    // Restore timer if draft was active on restart
    client.once('ready', () => manager.restoreTimer());

    return manager;
  }

  private async persist(): Promise<void> {
    const json = JSON.stringify(this.state, null, 2);
    const tmp = STATE_PATH + '.tmp';
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fs.writeFile(tmp, json, 'utf-8');
    await fs.rename(tmp, STATE_PATH);
  }

  // ─── Setup ────────────────────────────────────────────────────────────────

  async setup(config: Partial<DraftConfig>): Promise<void> {
    this.state.config = { ...this.state.config, ...config };
    await this.persist();
  }

  async registerTeam(teamAbbr: string, userId: string): Promise<RegisterResult> {
    if (!TEAMS[teamAbbr]) return { success: false, error: `Unknown team: ${teamAbbr}` };
    if (this.state.status === 'active' || this.state.status === 'complete') {
      return { success: false, error: 'Cannot register after the draft has started.' };
    }
    // Check if user already has a team
    const existing = Object.entries(this.state.assignments).find(([, uid]) => uid === userId);
    if (existing) {
      return { success: false, error: `You already control the **${TEAMS[existing[0]].name}**. Use \`/draft unregister\` first.` };
    }
    // Check if team already taken
    if (this.state.assignments[teamAbbr]) {
      return { success: false, error: `The **${TEAMS[teamAbbr].name}** are already claimed.` };
    }
    this.state.assignments[teamAbbr] = userId;
    await this.persist();
    return { success: true };
  }

  async unregisterTeam(userId: string): Promise<RegisterResult> {
    const entry = Object.entries(this.state.assignments).find(([, uid]) => uid === userId);
    if (!entry) return { success: false, error: "You don't have a team registered." };
    delete this.state.assignments[entry[0]];
    await this.persist();
    return { success: true };
  }

  async start(): Promise<{ success: boolean; error?: string }> {
    if (this.state.status === 'active') return { success: false, error: 'Draft is already active.' };
    if (this.state.status === 'complete') return { success: false, error: 'Draft is already complete. Use /draft reset to start over.' };
    if (!this.state.config.channelId) return { success: false, error: 'No draft channel set. Run /draft setup first.' };

    this.state.schedule = buildSchedule();
    this.state.currentPickIndex = 0;
    this.state.picks = [];
    this.state.availableRanks = PROSPECTS_DEDUPED.map(p => p.rank);
    this.state.status = 'active';
    this.state.timerExpiresAt = null;
    await this.persist();

    // Kick off first pick
    await this.advance();
    return { success: true };
  }

  async pause(): Promise<void> {
    if (this.state.status !== 'active') return;
    this.state.status = 'paused';
    this.clearTimer();
    await this.persist();
  }

  async resume(): Promise<void> {
    if (this.state.status !== 'paused') return;
    this.state.status = 'active';
    await this.persist();
    await this.advance();
  }

  async reset(): Promise<void> {
    this.clearTimer();
    this.state = { ...DEFAULT_STATE };
    await this.persist();
  }

  // ─── Picking ──────────────────────────────────────────────────────────────

  async makePick(userId: string, prospectRank: number): Promise<PickResult> {
    if (this.state.status !== 'active') {
      return { success: false, error: 'The draft is not currently active.' };
    }
    const slot = this.state.schedule[this.state.currentPickIndex];
    if (!slot) return { success: false, error: 'No pick available.' };

    // Verify user is authorized for current team
    if (!this.isAuthorizedForTeam(userId, slot.currentTeam)) {
      const onClock = TEAMS[slot.currentTeam]?.name ?? slot.currentTeam;
      return { success: false, error: `It's not your pick. The **${onClock}** are on the clock.` };
    }

    // Verify prospect available
    if (!this.state.availableRanks.includes(prospectRank)) {
      return { success: false, error: 'That player has already been drafted.' };
    }

    this.clearTimer();
    const prospect = PROSPECT_BY_RANK.get(prospectRank)!;
    const pick = await this.recordAndAnnounce(slot, prospectRank, userId, false);
    this.state.currentPickIndex++;
    await this.persist();
    await this.advance();

    return { success: true, pick };
  }

  async autoPick(userId: string | null): Promise<PickResult> {
    if (this.state.status !== 'active') {
      return { success: false, error: 'The draft is not currently active.' };
    }
    const slot = this.state.schedule[this.state.currentPickIndex];
    if (!slot) return { success: false, error: 'No pick available.' };

    // If userId provided, verify authorization
    if (userId !== null && !this.isAuthorizedForTeam(userId, slot.currentTeam)) {
      const onClock = TEAMS[slot.currentTeam]?.name ?? slot.currentTeam;
      return { success: false, error: `It's not your pick. The **${onClock}** are on the clock.` };
    }

    const bestRank = this.state.availableRanks[0];
    if (bestRank === undefined) return { success: false, error: 'No prospects available.' };

    this.clearTimer();
    const pick = await this.recordAndAnnounce(slot, bestRank, userId, true);
    this.state.currentPickIndex++;
    await this.persist();
    await this.advance();

    return { success: true, pick };
  }

  private async recordAndAnnounce(
    slot: PickSlot,
    prospectRank: number,
    userId: string | null,
    autoPicked: boolean
  ): Promise<CompletedPick> {
    const prospect = PROSPECT_BY_RANK.get(prospectRank)!;

    // Remove from available
    this.state.availableRanks = this.state.availableRanks.filter(r => r !== prospectRank);

    const pick: CompletedPick = {
      overall: slot.overall,
      round: slot.round,
      roundPick: slot.roundPick,
      team: slot.currentTeam,
      prospectRank,
      prospectName: prospect.name,
      pos: prospect.pos,
      school: prospect.school,
      userId,
      autoPicked,
      pickedAt: Date.now(),
    };

    this.state.picks.push(pick);

    // Announce in channel
    const embed = buildPickEmbed(pick, slot, TEAMS[slot.currentTeam]);
    await this.sendEmbed(embed);

    return pick;
  }

  // ─── Advance ──────────────────────────────────────────────────────────────

  private async advance(): Promise<void> {
    const maxRounds = this.state.config.rounds ?? 7;
    while (true) {
      const slot = this.state.schedule[this.state.currentPickIndex];
      if (this.state.currentPickIndex >= this.state.schedule.length || slot.round > maxRounds) {
        // Draft complete (all picks done, or configured round limit reached)
        this.state.status = 'complete';
        this.state.timerExpiresAt = null;
        await this.persist();
        await this.sendEmbed(buildDraftCompleteEmbed(this.state.picks, this.state.picks.length));
        await this.sendTeamSummaries();
        return;
      }
      const userId = this.state.assignments[slot.currentTeam] ?? null;

      if (!userId && this.state.config.autoPick) {
        // CPU pick — pick best available immediately
        const bestRank = this.state.availableRanks[0];
        if (bestRank === undefined) break;
        await this.recordAndAnnounce(slot, bestRank, null, true);
        this.state.currentPickIndex++;
        await this.persist();
        // Small delay to avoid Discord rate limits
        await delay(1500);
        continue;
      }

      // Human's turn (or CPU without autoPick)
      const team = TEAMS[slot.currentTeam];
      const embed = buildOnTheClockEmbed(slot, team, userId, this.state.config.timerSeconds);
      await this.sendEmbed(embed);

      if (this.state.config.timerSeconds && userId) {
        this.startTimer();
      }
      break;
    }
  }

  // ─── Timer ────────────────────────────────────────────────────────────────

  private startTimer(): void {
    const seconds = this.state.config.timerSeconds!;
    this.state.timerExpiresAt = Date.now() + seconds * 1000;
    this.timerHandle = setTimeout(() => this.onTimerExpired(), seconds * 1000);
  }

  private clearTimer(): void {
    if (this.timerHandle) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    this.state.timerExpiresAt = null;
  }

  private async onTimerExpired(): Promise<void> {
    if (this.state.timerExpiresAt === null) return; // already handled
    if (this.state.status !== 'active') return;
    console.log(`⏰ Timer expired for pick ${this.state.currentPickIndex + 1}`);
    this.state.timerExpiresAt = null;
    await this.autoPick(null);
  }

  private restoreTimer(): void {
    if (this.state.status !== 'active' || this.state.timerExpiresAt === null) return;
    const remaining = this.state.timerExpiresAt - Date.now();
    if (remaining <= 0) {
      setImmediate(() => this.onTimerExpired());
    } else {
      this.timerHandle = setTimeout(() => this.onTimerExpired(), remaining);
    }
  }

  // ─── Channel sending ──────────────────────────────────────────────────────

  private async sendEmbed(embed: import('discord.js').EmbedBuilder): Promise<void> {
    await this.sendEmbeds([embed]);
  }

  private async sendEmbeds(embeds: import('discord.js').EmbedBuilder[]): Promise<void> {
    if (!this.state.config.channelId) return;
    try {
      const channel = await this.client.channels.fetch(this.state.config.channelId);
      if (channel && channel.isTextBased() && 'send' in channel) {
        await (channel as TextChannel).send({ embeds });
      }
    } catch (err) {
      console.error('Failed to send embeds:', err);
    }
  }

  private async sendTeamSummaries(): Promise<void> {
    const teamAbbrs = Object.keys(TEAMS);
    // Send up to 10 embeds per message (Discord limit)
    for (let i = 0; i < teamAbbrs.length; i += 10) {
      const batch = teamAbbrs.slice(i, i + 10);
      const embeds = batch.map(abbr =>
        buildTeamRosterEmbed(TEAMS[abbr], abbr, this.state.picks.filter(p => p.team === abbr))
      );
      await this.sendEmbeds(embeds);
      if (i + 10 < teamAbbrs.length) await delay(800);
    }
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getState(): Readonly<DraftState> { return this.state; }

  getCurrentSlot(): PickSlot | null {
    return this.state.schedule[this.state.currentPickIndex] ?? null;
  }

  getUserTeam(userId: string): string | null {
    const primary = Object.entries(this.state.assignments).find(([, uid]) => uid === userId);
    if (primary) return primary[0];
    const co = Object.entries(this.state.coManagers).find(([, uids]) => uids.includes(userId));
    return co ? co[0] : null;
  }

  isPrimaryGM(userId: string, teamAbbr: string): boolean {
    return this.state.assignments[teamAbbr] === userId;
  }

  isAuthorizedForTeam(userId: string, teamAbbr: string): boolean {
    return this.state.assignments[teamAbbr] === userId ||
      (this.state.coManagers[teamAbbr] ?? []).includes(userId);
  }

  getUnassignedTeams(): string[] {
    return Object.keys(TEAMS).filter(abbr => !this.state.assignments[abbr]);
  }

  getAvailableProspects(pos?: string, page = 1, pageSize = 20): { prospects: typeof PROSPECTS_DEDUPED; totalPages: number; total: number } {
    const pool = this.state.availableRanks.length > 0
      ? PROSPECTS_DEDUPED.filter(p => this.state.availableRanks.includes(p.rank))
      : PROSPECTS_DEDUPED;
    const available = pool.filter(p => !pos || p.pos.toUpperCase() === pos.toUpperCase());
    const total = available.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const clampedPage = Math.max(1, Math.min(page, totalPages));
    const prospects = available.slice((clampedPage - 1) * pageSize, clampedPage * pageSize);
    return { prospects, totalPages, total };
  }

  searchProspects(query: string, pos?: string): typeof PROSPECTS_DEDUPED {
    const q = query.toLowerCase();
    return PROSPECTS_DEDUPED
      .filter(p =>
        this.state.availableRanks.includes(p.rank) &&
        p.name.toLowerCase().includes(q) &&
        (!pos || p.pos.toUpperCase() === pos.toUpperCase())
      )
      .slice(0, 25);
  }

  getTeamPicks(teamAbbr: string): CompletedPick[] {
    return this.state.picks.filter(p => p.team === teamAbbr);
  }

  getLastNPicks(n: number): CompletedPick[] {
    return this.state.picks.slice(-n).reverse();
  }

  getTimeRemaining(): number | null {
    if (!this.state.timerExpiresAt) return null;
    return Math.max(0, Math.round((this.state.timerExpiresAt - Date.now()) / 1000));
  }

  /** Returns the canonical player name if that player currently belongs to the given team. */
  resolvePlayer(nameQuery: string, teamAbbr: string): string | null {
    const q = nameQuery.toLowerCase();
    // Check if ownership was overridden by a trade
    const overrideTeam = this.state.playerOwnership[q];
    if (overrideTeam !== undefined) {
      return overrideTeam === teamAbbr ? nameQuery : null;
    }
    // Fall back to original roster — fuzzy match on name
    const roster = ROSTERS[teamAbbr] ?? [];
    const match = roster.find(p => p.name.toLowerCase().includes(q));
    return match ? match.name : null;
  }

  /** Returns the team that currently owns a player (by fuzzy name match). */
  getPlayerCurrentTeam(nameQuery: string): { name: string; team: string } | null {
    const q = nameQuery.toLowerCase();
    const override = this.state.playerOwnership[q];
    if (override !== undefined) {
      return { name: nameQuery, team: override };
    }
    for (const [abbr, players] of Object.entries(ROSTERS)) {
      const match = players.find(p => p.name.toLowerCase().includes(q));
      if (match) return { name: match.name, team: abbr };
    }
    return null;
  }

  /** Search roster players on a team for autocomplete. */
  searchRosterPlayers(teamAbbr: string, query: string): Array<{ name: string; pos: string }> {
    const q = query.toLowerCase();
    const baseRoster = ROSTERS[teamAbbr] ?? [];
    // Players traded to this team
    const tradedIn = Object.entries(this.state.playerOwnership)
      .filter(([, t]) => t === teamAbbr)
      .map(([nameLower]) => {
        // Find canonical name from any roster
        for (const players of Object.values(ROSTERS)) {
          const p = players.find(pl => pl.name.toLowerCase() === nameLower);
          if (p) return p;
        }
        return null;
      })
      .filter(Boolean) as Array<{ name: string; pos: string; number: string | null }>;

    // Players traded away from this team
    const tradedAwayNames = new Set(
      Object.entries(this.state.playerOwnership)
        .filter(([, t]) => t !== teamAbbr)
        .map(([n]) => n)
    );

    const current = [
      ...baseRoster.filter(p => !tradedAwayNames.has(p.name.toLowerCase())),
      ...tradedIn,
    ];

    return current
      .filter(p => p.name.toLowerCase().includes(q))
      .slice(0, 25)
      .map(p => ({ name: p.name, pos: p.pos }));
  }

  getFuturePicksForTeam(teamAbbr: string): PickSlot[] {
    // If draft hasn't started yet, show the projected initial schedule
    const schedule = this.state.schedule.length > 0
      ? this.state.schedule
      : buildSchedule();
    return schedule
      .slice(this.state.currentPickIndex)
      .filter(s => s.currentTeam === teamAbbr);
  }

  getFuturePickRightsForTeam(teamAbbr: string): FuturePickRight[] {
    return this.state.futurePickRights.filter(r => r.currentTeam === teamAbbr);
  }

  /** Find a future pick right owned by a team, by year+round. Returns the right's id. */
  resolveFuturePickRight(teamAbbr: string, year: number, round: number): FuturePickRight | null {
    return this.state.futurePickRights.find(
      r => r.currentTeam === teamAbbr && r.year === year && r.round === round
    ) ?? null;
  }

  /** Resolve a pick's overall number from round.roundPick notation (e.g. 1.5 → 5). */
  resolvePickByRoundPick(round: number, roundPick: number): number | null {
    const schedule = this.state.schedule.length > 0 ? this.state.schedule : buildSchedule();
    const slot = schedule.find(s => s.round === round && s.roundPick === roundPick);
    return slot?.overall ?? null;
  }

  /** Resolve a player name from jersey number on a team's current roster. */
  resolvePlayerByJersey(teamAbbr: string, jersey: string): string | null {
    const baseRoster = ROSTERS[teamAbbr] ?? [];
    const tradedAwayNames = new Set(
      Object.entries(this.state.playerOwnership)
        .filter(([, t]) => t !== teamAbbr)
        .map(([n]) => n)
    );
    const tradedIn = Object.entries(this.state.playerOwnership)
      .filter(([, t]) => t === teamAbbr)
      .flatMap(([nameLower]) => {
        for (const players of Object.values(ROSTERS)) {
          const p = players.find(pl => pl.name.toLowerCase() === nameLower);
          if (p) return [p];
        }
        return [];
      });
    const current = [
      ...baseRoster.filter(p => !tradedAwayNames.has(p.name.toLowerCase())),
      ...tradedIn,
    ];
    return current.find(p => p.number === jersey)?.name ?? null;
  }

  /** Get full current roster for a team (no query filter, no limit). */
  getFullRoster(teamAbbr: string): Array<{ name: string; pos: string; number: string | null }> {
    const baseRoster = ROSTERS[teamAbbr] ?? [];
    const tradedAwayNames = new Set(
      Object.entries(this.state.playerOwnership)
        .filter(([, t]) => t !== teamAbbr)
        .map(([n]) => n)
    );
    const tradedIn = Object.entries(this.state.playerOwnership)
      .filter(([, t]) => t === teamAbbr)
      .flatMap(([nameLower]) => {
        for (const players of Object.values(ROSTERS)) {
          const p = players.find(pl => pl.name.toLowerCase() === nameLower);
          if (p) return [p];
        }
        return [];
      });
    return [
      ...baseRoster.filter(p => !tradedAwayNames.has(p.name.toLowerCase())),
      ...tradedIn,
    ];
  }

  async rewind(round: number, roundPick: number): Promise<{ success: boolean; error?: string }> {
    if (this.state.status !== 'active' && this.state.status !== 'paused') {
      return { success: false, error: 'Draft must be active or paused to rewind.' };
    }

    const targetIndex = this.state.schedule.findIndex(
      s => s.round === round && s.roundPick === roundPick
    );

    if (targetIndex === -1) {
      return { success: false, error: `No pick found at Round ${round}, Pick ${roundPick}.` };
    }
    if (targetIndex >= this.state.currentPickIndex) {
      return { success: false, error: 'That pick hasn\'t been made yet — nothing to rewind.' };
    }

    // Undo all picks from targetIndex onwards
    const overallsToUndo = new Set(
      this.state.schedule.slice(targetIndex, this.state.currentPickIndex).map(s => s.overall)
    );
    const picksToUndo = this.state.picks.filter(p => overallsToUndo.has(p.overall));

    for (const p of picksToUndo) {
      this.state.availableRanks.push(p.prospectRank);
    }
    this.state.availableRanks.sort((a, b) => a - b);
    this.state.picks = this.state.picks.filter(p => !overallsToUndo.has(p.overall));

    this.state.currentPickIndex = targetIndex;
    this.state.status = 'active';
    this.clearTimer();
    this.state.timerExpiresAt = null;

    await this.persist();
    await this.advance();
    return { success: true };
  }

  getPendingTradesForUser(userId: string): PendingTrade[] {
    this.cleanExpiredTrades();
    return this.state.pendingTrades.filter(t =>
      t.proposerUserId === userId || t.receiverUserId === userId
    );
  }

  // ─── Trades ───────────────────────────────────────────────────────────────

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
    if (offeredOveralls.length + offeredPlayers.length + offeredFuturePickIds.length === 0 ||
        requestedOveralls.length + requestedPlayers.length + requestedFuturePickIds.length === 0) {
      return { success: false, error: 'Must include at least one pick or player on each side.' };
    }

    const proposerTeam = this.getUserTeam(proposerUserId);
    if (!proposerTeam) return { success: false, error: 'You do not have a registered team.' };

    const receiverTeam = this.getUserTeam(receiverUserId);
    if (!receiverTeam) return { success: false, error: 'That user does not have a registered team.' };

    if (proposerTeam === receiverTeam) return { success: false, error: 'Cannot trade with yourself.' };

    this.cleanExpiredTrades();

    const futurePicks = this.state.schedule.slice(this.state.currentPickIndex);

    for (const overall of offeredOveralls) {
      const slot = futurePicks.find(s => s.overall === overall);
      if (!slot) return { success: false, error: `Pick #${overall} is not a future pick.` };
      if (slot.currentTeam !== proposerTeam) return { success: false, error: `Pick #${overall} does not belong to your team (${TEAMS[proposerTeam]?.name}).` };
      if (this.isPickInPendingTrade(overall)) return { success: false, error: `Pick #${overall} is already part of a pending trade.` };
    }

    for (const overall of requestedOveralls) {
      const slot = futurePicks.find(s => s.overall === overall);
      if (!slot) return { success: false, error: `Pick #${overall} is not a future pick.` };
      if (slot.currentTeam !== receiverTeam) return { success: false, error: `Pick #${overall} does not belong to ${TEAMS[receiverTeam]?.name}.` };
      if (this.isPickInPendingTrade(overall)) return { success: false, error: `Pick #${overall} is already part of a pending trade.` };
    }

    // Validate offered players belong to proposer
    const resolvedOfferedPlayers: string[] = [];
    for (const name of offeredPlayers) {
      const result = this.resolvePlayer(name, proposerTeam);
      if (!result) return { success: false, error: `Player "${name}" not found on the ${TEAMS[proposerTeam]?.name}.` };
      resolvedOfferedPlayers.push(result);
    }

    // Validate requested players belong to receiver
    const resolvedRequestedPlayers: string[] = [];
    for (const name of requestedPlayers) {
      const result = this.resolvePlayer(name, receiverTeam);
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

    this.state.pendingTrades.push(trade);
    await this.persist();
    return { success: true, trade };
  }

  async acceptTrade(
    userId: string,
    tradeId: string
  ): Promise<{ success: boolean; error?: string; trade?: PendingTrade }> {
    this.cleanExpiredTrades();

    const trade = this.state.pendingTrades.find(t => t.id === tradeId);
    if (!trade) return { success: false, error: 'Trade not found or expired.' };
    if (!this.isAuthorizedForTeam(userId, trade.receiverTeam)) return { success: false, error: 'This trade was not sent to you.' };

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

    await this.persist();
    await this.sendEmbed(buildTradeExecutedEmbed(trade, TEAMS, this.state.schedule));

    // If the current pick was part of this trade, reset the clock for the new owner
    const currentSlot = this.state.schedule[this.state.currentPickIndex];
    if (currentSlot && involved.has(currentSlot.overall)) {
      this.clearTimer();
      await this.refreshClock();
    }

    return { success: true, trade };
  }

  async declineTrade(
    userId: string,
    tradeId: string
  ): Promise<{ success: boolean; error?: string }> {
    const trade = this.state.pendingTrades.find(t => t.id === tradeId);
    if (!trade) return { success: false, error: 'Trade not found or expired.' };
    if (!this.isAuthorizedForTeam(userId, trade.proposerTeam) && !this.isAuthorizedForTeam(userId, trade.receiverTeam)) {
      return { success: false, error: 'You are not part of this trade.' };
    }

    this.state.pendingTrades = this.state.pendingTrades.filter(t => t.id !== tradeId);
    await this.persist();
    return { success: true };
  }

  // ─── Co-Manager Management ────────────────────────────────────────────────

  async addCoManager(requesterId: string, coManagerId: string): Promise<{ success: boolean; error?: string }> {
    const team = this.getUserTeam(requesterId);
    if (!team) return { success: false, error: 'You do not have a registered team.' };
    if (!this.isPrimaryGM(requesterId, team)) return { success: false, error: 'Only the primary GM can manage co-managers.' };
    if (this.getUserTeam(coManagerId)) return { success: false, error: 'That user already has a team or is a co-manager.' };
    if (!this.state.coManagers[team]) this.state.coManagers[team] = [];
    if (this.state.coManagers[team].includes(coManagerId)) return { success: false, error: 'That user is already a co-manager for your team.' };
    this.state.coManagers[team].push(coManagerId);
    await this.persist();
    return { success: true };
  }

  async removeCoManager(requesterId: string, coManagerId: string): Promise<{ success: boolean; error?: string }> {
    const team = this.getUserTeam(requesterId);
    if (!team) return { success: false, error: 'You do not have a registered team.' };
    if (!this.isPrimaryGM(requesterId, team)) return { success: false, error: 'Only the primary GM can manage co-managers.' };
    const list = this.state.coManagers[team] ?? [];
    if (!list.includes(coManagerId)) return { success: false, error: 'That user is not a co-manager for your team.' };
    this.state.coManagers[team] = list.filter(id => id !== coManagerId);
    await this.persist();
    return { success: true };
  }

  getCoManagers(teamAbbr: string): string[] {
    return this.state.coManagers[teamAbbr] ?? [];
  }

  // ─── Admin Operations ─────────────────────────────────────────────────────

  async adminAssignTeam(teamAbbr: string, userId: string): Promise<{ success: boolean; error?: string }> {
    if (!TEAMS[teamAbbr]) return { success: false, error: `Unknown team: ${teamAbbr}` };
    // Remove user from any existing team
    for (const abbr of Object.keys(this.state.assignments)) {
      if (this.state.assignments[abbr] === userId) delete this.state.assignments[abbr];
    }
    // Remove as co-manager anywhere
    for (const abbr of Object.keys(this.state.coManagers)) {
      this.state.coManagers[abbr] = this.state.coManagers[abbr].filter(id => id !== userId);
    }
    this.state.assignments[teamAbbr] = userId;
    await this.persist();
    return { success: true };
  }

  async adminAddCoManager(teamAbbr: string, userId: string): Promise<{ success: boolean; error?: string }> {
    if (!TEAMS[teamAbbr]) return { success: false, error: `Unknown team: ${teamAbbr}` };
    if (!this.state.assignments[teamAbbr]) return { success: false, error: `No GM registered for ${teamAbbr}.` };
    if (this.getUserTeam(userId)) return { success: false, error: 'That user already has a team or is a co-manager.' };
    if (!this.state.coManagers[teamAbbr]) this.state.coManagers[teamAbbr] = [];
    if (this.state.coManagers[teamAbbr].includes(userId)) return { success: false, error: 'That user is already a co-manager for that team.' };
    this.state.coManagers[teamAbbr].push(userId);
    await this.persist();
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
    await this.persist();
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
    await this.persist();
    await this.sendEmbed(buildTradeExecutedEmbed(trade, TEAMS, this.state.schedule));

    const currentSlot = this.state.schedule[this.state.currentPickIndex];
    const involved = new Set([...offeredOveralls, ...requestedOveralls]);
    if (currentSlot && involved.has(currentSlot.overall)) {
      this.clearTimer();
      await this.refreshClock();
    }

    return { success: true, trade };
  }

  getTradeHistory(): PendingTrade[] {
    return this.state.tradeHistory;
  }

  private async refreshClock(): Promise<void> {
    const slot = this.state.schedule[this.state.currentPickIndex];
    if (!slot || this.state.status !== 'active') return;

    const userId = this.state.assignments[slot.currentTeam] ?? null;

    if (!userId && this.state.config.autoPick) {
      // New owner is CPU — pick immediately
      const bestRank = this.state.availableRanks[0];
      if (bestRank === undefined) return;
      await this.recordAndAnnounce(slot, bestRank, null, true);
      this.state.currentPickIndex++;
      await this.persist();
      await delay(1500);
      await this.advance();
      return;
    }

    const team = TEAMS[slot.currentTeam];
    const embed = buildOnTheClockEmbed(slot, team, userId, this.state.config.timerSeconds);
    await this.sendEmbed(embed);

    if (this.state.config.timerSeconds && userId) {
      this.startTimer();
    }
  }

  private isPickInPendingTrade(overall: number): boolean {
    return this.state.pendingTrades.some(t =>
      t.offeredOveralls.includes(overall) || t.requestedOveralls.includes(overall)
    );
  }

  private cleanExpiredTrades(): void {
    const now = Date.now();
    this.state.pendingTrades = this.state.pendingTrades.filter(t => t.expiresAt > now);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateTradeId(): string {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}
