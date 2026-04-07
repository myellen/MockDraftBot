import { Client, TextChannel } from 'discord.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  DraftState, DraftStatus, DraftConfig, CompletedPick,
  PickSlot, PickResult, RegisterResult, PendingTrade, FuturePickRight, BoardData,
  PlayerSalary, TeamCapInfo
} from './types';
import { buildSchedule } from './scheduleBuilder';
import { FUTURE_PICK_TRADES } from '../data/draftOrder';
import { PROSPECTS_DEDUPED, PROSPECT_BY_RANK } from '../data/prospects';
import { TEAMS } from '../data/teams';
import { ROSTERS } from '../data/rosters';
import { SALARIES, SALARY_CAP, getRookieCapHit } from '../data/salaries';
import { buildPickEmbed, buildOnTheClockEmbed, buildDraftCompleteEmbed, buildTeamRosterEmbed, buildTradeExecutedEmbed } from '../utils/embeds';

function statePath(guildId: string): string {
  return path.join(__dirname, `../../data/draft-state-${guildId}.json`);
}

function boardPath(guildId: string): string {
  return path.join(__dirname, `../../data/draft-boards-${guildId}.json`);
}

const DEFAULT_BOARD_DATA: BoardData = {
  customBoards: {},
  positionPriority: {},
};

function buildFuturePickRights(): FuturePickRight[] {
  const rights: FuturePickRight[] = [];
  for (const year of [2027, 2028]) {
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
  config: { channelId: null, timerSeconds: null, autoPick: true, rounds: 7, allowPlayerTrades: true, tradeAnnouncement: 'intrigue', enforceSalaryCap: false },
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
  private boardData: BoardData;
  private timerHandle: NodeJS.Timeout | null = null;
  private client: Client;
  private guildId: string;

  private constructor(client: Client, state: DraftState, boardData: BoardData, guildId: string) {
    this.client = client;
    this.state = state;
    this.boardData = boardData;
    this.guildId = guildId;
  }

  static async load(client: Client, guildId: string): Promise<DraftManager> {
    let state: DraftState;
    try {
      const raw = await fs.readFile(statePath(guildId), 'utf-8');
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
          config: { ...(parsed.config as DraftConfig), rounds: (parsed.config as DraftConfig).rounds ?? 7, allowPlayerTrades: (parsed.config as DraftConfig).allowPlayerTrades ?? true, tradeAnnouncement: (parsed.config as DraftConfig).tradeAnnouncement ?? 'intrigue' },
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

    let boardData: BoardData;
    try {
      const raw = await fs.readFile(boardPath(guildId), 'utf-8');
      const parsed = JSON.parse(raw) as BoardData;
      boardData = {
        customBoards: parsed.customBoards ?? {},
        positionPriority: parsed.positionPriority ?? {},
      };
    } catch {
      boardData = { ...DEFAULT_BOARD_DATA };
    }

    const manager = new DraftManager(client, state, boardData, guildId);

    // Restore timer if draft was active on restart
    client.once('ready', () => manager.restoreTimer());

    return manager;
  }

  private async persist(): Promise<void> {
    const p = statePath(this.guildId);
    const tmp = p + '.tmp';
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
    await fs.rename(tmp, p);
  }

  private async persistBoards(): Promise<void> {
    const p = boardPath(this.guildId);
    const tmp = p + '.tmp';
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(this.boardData, null, 2), 'utf-8');
    await fs.rename(tmp, p);
  }

  // ─── Setup ────────────────────────────────────────────────────────────────

  getConfig(): DraftConfig { return this.state.config; }

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
    // Soft reset — clears live draft data, preserves assignments/boards/config
    this.clearTimer();
    this.state = {
      ...this.state,
      status: 'idle',
      schedule: [],
      currentPickIndex: 0,
      picks: [],
      availableRanks: [],
      timerExpiresAt: null,
      pendingTrades: [],
      tradeHistory: [],
    };
    await this.persist();
  }

  async wipe(): Promise<void> {
    // Hard reset — clears everything back to blank slate including boards
    this.clearTimer();
    this.state = { ...DEFAULT_STATE };
    this.boardData = { ...DEFAULT_BOARD_DATA };
    await this.persist();
    await this.persistBoards();
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

  async adminMakePick(prospectRank: number): Promise<PickResult> {
    if (this.state.status !== 'active') {
      return { success: false, error: 'The draft is not currently active.' };
    }
    const slot = this.state.schedule[this.state.currentPickIndex];
    if (!slot) return { success: false, error: 'No pick available.' };

    if (!this.state.availableRanks.includes(prospectRank)) {
      return { success: false, error: 'That player has already been drafted.' };
    }

    this.clearTimer();
    const pick = await this.recordAndAnnounce(slot, prospectRank, 'admin', false);
    this.state.currentPickIndex++;
    await this.persist();
    await this.advance();

    return { success: true, pick };
  }

  // ─── Custom Board / Position Priority ────────────────────────────────────

  /** Fallback chain: custom board → position priority → default rank order */
  private getBestPickForTeam(teamAbbr: string): number | undefined {
    const available = new Set(this.state.availableRanks);

    const board = this.boardData.customBoards[teamAbbr];
    if (board?.length) {
      const pick = board.find(rank => available.has(rank));
      if (pick !== undefined) return pick;
    }

    const priority = this.boardData.positionPriority[teamAbbr];
    if (priority?.length) {
      for (const pos of priority) {
        const pick = this.state.availableRanks.find(rank => PROSPECT_BY_RANK.get(rank)?.pos === pos);
        if (pick !== undefined) return pick;
      }
    }

    return this.state.availableRanks[0];
  }

  submitBoard(teamAbbr: string, rankedNames: string[]): { matched: number; unmatched: string[] } {
    const nameToRank = new Map<string, number>();
    for (const [rank, p] of PROSPECT_BY_RANK) nameToRank.set(p.name.toLowerCase(), rank);

    const ranks: number[] = [];
    const unmatched: string[] = [];
    for (const name of rankedNames) {
      const rank = nameToRank.get(name.toLowerCase());
      if (rank !== undefined) ranks.push(rank);
      else unmatched.push(name);
    }
    this.boardData.customBoards[teamAbbr] = ranks;
    void this.persistBoards();
    return { matched: ranks.length, unmatched };
  }

  setPositionPriority(teamAbbr: string, positions: string[]): void {
    this.boardData.positionPriority[teamAbbr] = positions;
    void this.persistBoards();
  }

  clearBoard(teamAbbr: string, what: 'board' | 'priority' | 'all'): void {
    if (what === 'board' || what === 'all') delete this.boardData.customBoards[teamAbbr];
    if (what === 'priority' || what === 'all') delete this.boardData.positionPriority[teamAbbr];
    void this.persistBoards();
  }

  getCustomBoard(teamAbbr: string): number[] {
    return this.boardData.customBoards[teamAbbr] ?? [];
  }

  getPositionPriority(teamAbbr: string): string[] {
    return this.boardData.positionPriority[teamAbbr] ?? [];
  }

  getMyBoardPage(teamAbbr: string, page: number, pageSize = 20): {
    entries: { boardPos: number; rank: number; name: string; pos: string; school: string; available: boolean }[];
    total: number;
    totalPages: number;
    page: number;
  } {
    const board = this.boardData.customBoards[teamAbbr] ?? [];
    const available = new Set(this.state.availableRanks);
    const total = board.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const slice = board.slice((safePage - 1) * pageSize, safePage * pageSize);
    const entries = slice.map((rank, i) => {
      const p = PROSPECT_BY_RANK.get(rank);
      return {
        boardPos: (safePage - 1) * pageSize + i + 1,
        rank,
        name: p?.name ?? `#${rank}`,
        pos: p?.pos ?? '?',
        school: p?.school ?? '?',
        available: available.has(rank),
      };
    });
    return { entries, total, totalPages, page: safePage };
  }

  // ─── Auto-pick ────────────────────────────────────────────────────────────

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

    const bestRank = this.getBestPickForTeam(slot.currentTeam);
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
        const bestRank = this.getBestPickForTeam(slot.currentTeam);
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
      await this.sendEmbed(embed, userId ? `<@${userId}>` : undefined);

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

  private async sendEmbed(embed: import('discord.js').EmbedBuilder, content?: string): Promise<void> {
    await this.sendMessage({ embeds: [embed], content });
  }

  private async sendEmbeds(embeds: import('discord.js').EmbedBuilder[]): Promise<void> {
    await this.sendMessage({ embeds });
  }

  private async sendMessage(opts: { embeds?: import('discord.js').EmbedBuilder[]; content?: string }): Promise<void> {
    if (!this.state.config.channelId) return;
    try {
      const channel = await this.client.channels.fetch(this.state.config.channelId);
      if (channel && channel.isTextBased() && 'send' in channel) {
        await (channel as TextChannel).send(opts);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
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
    return Object.keys(TEAMS)
      .filter(abbr => !this.state.assignments[abbr])
      .sort((a, b) => TEAMS[a].name.localeCompare(TEAMS[b].name));
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

  // ─── Salary Cap ─────────────────────────────────────────────────────────────

  /**
   * Look up the salary data for a player on a given team.
   * Checks the team's salary table first, then searches all teams if traded.
   */
  getPlayerSalary(playerName: string, teamAbbr: string): PlayerSalary | null {
    const key = playerName.toLowerCase();
    // Check this team's salary data first
    const teamSalaries = SALARIES[teamAbbr];
    if (teamSalaries?.[key]) return teamSalaries[key];
    // If the player was traded to this team, look up their original team's salary
    for (const [origTeam, salaries] of Object.entries(SALARIES)) {
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
    let capUsed = 0;
    let deadMoney = 0;

    const teamSalaries = SALARIES[teamAbbr] ?? {};
    const baseRoster = ROSTERS[teamAbbr] ?? [];

    // 1. Process original roster players
    for (const player of baseRoster) {
      const key = player.name.toLowerCase();
      const salary = teamSalaries[key];
      if (!salary) continue;

      const tradedTo = this.state.playerOwnership[key];
      if (tradedTo !== undefined && tradedTo !== teamAbbr) {
        // Player was traded away — dead money stays on this team
        deadMoney += salary.deadMoney;
        capUsed += salary.deadMoney;
      } else {
        // Player still on team — full cap hit
        capUsed += salary.capHit;
      }
    }

    // 2. Add players traded IN from other teams
    for (const [nameLower, ownerTeam] of Object.entries(this.state.playerOwnership)) {
      if (ownerTeam !== teamAbbr) continue;
      // Skip if this player was originally on this team (already counted above)
      if (baseRoster.some(p => p.name.toLowerCase() === nameLower)) continue;

      const origTeam = this.getPlayerOriginalSalaryTeam(nameLower);
      if (!origTeam) continue;
      const origSalary = SALARIES[origTeam]?.[nameLower];
      if (!origSalary) continue;
      // Receiving team takes on: capHit - deadMoney (the transferable portion)
      capUsed += origSalary.capHit - origSalary.deadMoney;
    }

    // 3. Add rookie cap hits for drafted players on this team
    for (const pick of this.state.picks) {
      if (pick.team === teamAbbr) {
        capUsed += getRookieCapHit(pick.overall);
      }
    }

    return {
      capUsed,
      capSpace: SALARY_CAP - capUsed,
      deadMoney,
    };
  }

  /**
   * Calculate the cap impact of a trade for both teams BEFORE execution.
   * Returns the cap space change for each team (negative = less space).
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

    // Players proposer sends to receiver
    for (const name of trade.offeredPlayers) {
      const origTeam = this.getPlayerOriginalSalaryTeam(name.toLowerCase());
      if (!origTeam) continue;
      const salary = SALARIES[origTeam]?.[name.toLowerCase()];
      if (!salary) continue;

      // If the player is currently on the proposer's team:
      // Was the player originally on proposer's team or traded in?
      const wasOriginallyOnProposer = origTeam === trade.proposerTeam;

      if (wasOriginallyOnProposer) {
        // Proposer loses full cap hit, gains dead money
        proposerCapDelta += salary.deadMoney - salary.capHit;
        // Receiver takes on transferable portion
        receiverCapDelta += salary.capHit - salary.deadMoney;
      } else {
        // Player was previously traded to proposer — their cap charge was already (capHit - deadMoney)
        // Trading them again: proposer drops the transferable portion, receiver picks it up
        const transferable = salary.capHit - salary.deadMoney;
        proposerCapDelta -= transferable;
        receiverCapDelta += transferable;
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
        receiverCapDelta += salary.deadMoney - salary.capHit;
        proposerCapDelta += salary.capHit - salary.deadMoney;
      } else {
        const transferable = salary.capHit - salary.deadMoney;
        receiverCapDelta -= transferable;
        proposerCapDelta += transferable;
      }
    }

    return {
      proposerCapChange: proposerCapDelta,
      receiverCapChange: receiverCapDelta,
      proposerNewSpace: proposerCap.capSpace + proposerCapDelta, // delta is negative when cap used increases
      receiverNewSpace: receiverCap.capSpace + receiverCapDelta,
    };
  }

  /**
   * Validate that a trade would not put either team over the salary cap.
   * Only enforced when enforceSalaryCap is enabled in config.
   */
  validateTradeCap(trade: PendingTrade): { valid: boolean; error?: string } {
    if (!this.state.config.enforceSalaryCap) return { valid: true };
    if (trade.offeredPlayers.length === 0 && trade.requestedPlayers.length === 0) {
      return { valid: true }; // pick-only trades have no cap impact
    }

    const impact = this.calculateTradeCapImpact(trade);

    if (impact.proposerNewSpace < 0) {
      const over = Math.abs(impact.proposerNewSpace);
      return {
        valid: false,
        error: `Trade would put the **${TEAMS[trade.proposerTeam]?.name ?? trade.proposerTeam}** $${formatCapAmount(over)} over the salary cap.`,
      };
    }
    if (impact.receiverNewSpace < 0) {
      const over = Math.abs(impact.receiverNewSpace);
      return {
        valid: false,
        error: `Trade would put the **${TEAMS[trade.receiverTeam]?.name ?? trade.receiverTeam}** $${formatCapAmount(over)} over the salary cap.`,
      };
    }

    return { valid: true };
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
    const team = this.getUserTeam(userId);
    if (!team) return [];
    return this.state.pendingTrades.filter(t =>
      t.proposerTeam === team || t.receiverTeam === team
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
    if (!this.state.config.allowPlayerTrades && (offeredPlayers.length > 0 || requestedPlayers.length > 0)) {
      return { success: false, error: 'Player trades are disabled for this draft. Only picks can be traded.' };
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
    }

    for (const overall of requestedOveralls) {
      const slot = futurePicks.find(s => s.overall === overall);
      if (!slot) return { success: false, error: `Pick #${overall} is not a future pick.` };
      if (slot.currentTeam !== receiverTeam) return { success: false, error: `Pick #${overall} does not belong to ${TEAMS[receiverTeam]?.name}.` };
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

    // Validate salary cap implications
    const capCheck = this.validateTradeCap(trade);
    if (!capCheck.valid) return { success: false, error: capCheck.error };

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

    // Re-validate salary cap at acceptance time (cap situation may have changed)
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
      const bestRank = this.getBestPickForTeam(slot.currentTeam);
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
    await this.sendEmbed(embed, userId ? `<@${userId}>` : undefined);

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

/** Format a cap amount in thousands to a readable string (e.g. 12500 → "12.5M"). */
export function formatCapAmount(amountInThousands: number): string {
  const millions = amountInThousands / 1000;
  if (Math.abs(millions) >= 1) {
    return `${millions.toFixed(1).replace(/\.0$/, '')}M`;
  }
  return `${amountInThousands}K`;
}
