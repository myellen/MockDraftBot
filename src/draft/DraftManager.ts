import { Client, TextChannel } from 'discord.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  DraftState, DraftStatus, DraftConfig, CompletedPick, CancelledTrade,
  PickSlot, PickResult, RegisterResult, PendingTrade, FuturePickRight, BoardData,
} from './types';
import { TradeManager } from './TradeManager';
import { buildSchedule } from './scheduleBuilder';
import { FUTURE_PICK_TRADES } from '../data/draftOrder';
import { PROSPECTS_DEDUPED, PROSPECT_BY_RANK } from '../data/prospects';
import { TEAMS } from '../data/teams';
import { ROSTERS } from '../data/rosters';
import { buildPickEmbed, buildOnTheClockEmbed, buildDraftCompleteEmbed, buildTeamRosterEmbed } from '../utils/embeds';
import { isOllamaConfigured } from '../llm/OllamaService';
import { smartAutopick } from '../llm/SmartAutopick';

export { formatCapAmount } from './TradeManager';

function statePath(guildId: string): string {
  return path.join(__dirname, `../../data/draft-state-${guildId}.json`);
}

function boardPath(guildId: string): string {
  return path.join(__dirname, `../../data/draft-boards-${guildId}.json`);
}

const DEFAULT_BOARD_DATA: BoardData = {
  customBoards: {},
  strategyNotes: {},
  strategyPrompts: {},
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
  cancelledTrades: [],
  playerOwnership: {},
  futurePickRights: buildFuturePickRights(),
};

export class DraftManager {
  private state: DraftState;
  private boardData: BoardData;
  private timerHandle: NodeJS.Timeout | null = null;
  private client: Client;
  private guildId: string;
  public readonly trades: TradeManager;

  private constructor(client: Client, state: DraftState, boardData: BoardData, guildId: string) {
    this.client = client;
    this.state = state;
    this.boardData = boardData;
    this.guildId = guildId;
    this.trades = new TradeManager(this.state, {
      persist: () => this.persist(),
      sendEmbed: (embed, content) => this.sendEmbed(embed, content),
      getUserTeam: (id) => this.getUserTeam(id),
      isAuthorizedForTeam: (uid, team) => this.isAuthorizedForTeam(uid, team),
      resolvePlayer: (name, team) => this.resolvePlayer(name, team),
      clearTimer: () => this.clearTimer(),
      refreshClock: () => this.refreshClock(),
    });
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
          cancelledTrades: (raw.cancelledTrades as CancelledTrade[] | undefined) ?? [],
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
        strategyNotes: parsed.strategyNotes ?? {},
        strategyPrompts: (parsed as any).strategyPrompts ?? {},
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
      cancelledTrades: [],
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
    const pick = await this.recordAndAnnounce(slot, prospectRank, userId, false);
    this.state.currentPickIndex++;
    await this.persist();
    const completionEmbeds = await this.advance();

    return { success: true, pick, completionEmbeds };
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
    const completionEmbeds = await this.advance();

    return { success: true, pick, completionEmbeds };
  }

  // ─── Custom Board / Strategy ─────────────────────────────────────────────

  /** Fallback chain: smart pick (LLM) → custom board → BPA (default rank order) */
  private async getBestPickForTeam(teamAbbr: string): Promise<number | undefined> {
    const available = new Set(this.state.availableRanks);

    // 1. Smart pick via LLM (when Ollama is available)
    if (isOllamaConfigured()) {
      const slot = this.state.schedule[this.state.currentPickIndex];
      const draftedByTeam = this.state.picks
        .filter(p => p.team === teamAbbr)
        .map(p => ({ name: p.prospectName, pos: p.pos }));
      const posCounts: Record<string, number> = {};
      for (const p of draftedByTeam) {
        posCounts[p.pos] = (posCounts[p.pos] || 0) + 1;
      }
      const smartRank = await smartAutopick(teamAbbr, this.boardData.strategyPrompts[teamAbbr], {
        availableRanks: this.state.availableRanks,
        boardRanks: this.boardData.customBoards[teamAbbr] ?? [],
        draftedByTeam,
        rosterPosCounts: posCounts,
        pickInfo: { round: slot.round, roundPick: slot.roundPick, overall: slot.overall },
      });
      if (smartRank !== undefined && available.has(smartRank)) return smartRank;
    }

    // 2. Custom board fallback (when Ollama unavailable or LLM failed)
    const board = this.boardData.customBoards[teamAbbr];
    if (board?.length) {
      const pick = board.find(rank => available.has(rank));
      if (pick !== undefined) return pick;
    }

    // 3. BPA (default rank order)
    return this.state.availableRanks[0];
  }

  submitBoard(teamAbbr: string, rankedNames: string[]): { matched: number; unmatched: string[] } {
    const nameToRank = new Map<string, number>();
    for (const [rank, p] of PROSPECT_BY_RANK) nameToRank.set(p.name.toLowerCase(), rank);

    const ranks: number[] = [];
    const unmatched: string[] = [];
    for (const rawName of rankedNames) {
      // Strip parenthetical suffixes like "(QB, Alabama)" that LLMs sometimes append
      const name = rawName.replace(/\s*\(.*\)\s*$/, '').trim();
      const rank = nameToRank.get(name.toLowerCase());
      if (rank !== undefined) ranks.push(rank);
      else unmatched.push(rawName);
    }
    this.boardData.customBoards[teamAbbr] = ranks;
    void this.persistBoards();
    return { matched: ranks.length, unmatched };
  }

  clearBoard(teamAbbr: string, what: 'board' | 'strategy' | 'all'): void {
    if (what === 'board' || what === 'all') delete this.boardData.customBoards[teamAbbr];
    if (what === 'strategy' || what === 'all') delete this.boardData.strategyPrompts[teamAbbr];
    if (what === 'all') delete this.boardData.strategyNotes[teamAbbr];
    void this.persistBoards();
  }

  getCustomBoard(teamAbbr: string): number[] {
    return this.boardData.customBoards[teamAbbr] ?? [];
  }

  getStrategyPrompt(teamAbbr: string): string | undefined {
    return this.boardData.strategyPrompts[teamAbbr];
  }

  setStrategyPrompt(teamAbbr: string, prompt: string): void {
    this.boardData.strategyPrompts[teamAbbr] = prompt;
    void this.persistBoards();
  }

  clearStrategyPrompt(teamAbbr: string): void {
    delete this.boardData.strategyPrompts[teamAbbr];
    void this.persistBoards();
  }

  getStrategyNotes(teamAbbr: string): string[] {
    return this.boardData.strategyNotes[teamAbbr] ?? [];
  }

  addStrategyNote(teamAbbr: string, note: string, maxNotes = 5): void {
    const notes = this.boardData.strategyNotes[teamAbbr] ?? [];
    notes.push(note);
    if (notes.length > maxNotes) notes.splice(0, notes.length - maxNotes);
    this.boardData.strategyNotes[teamAbbr] = notes;
    void this.persistBoards();
  }

  getMyBoardPage(teamAbbr: string, page: number, pageSize = 20): {
    entries: { boardPos: number; rank: number; name: string; pos: string; school: string; available: boolean }[];
    total: number;
    totalPages: number;
    page: number;
  } {
    const board = this.boardData.customBoards[teamAbbr] ?? [];
    // Before draft starts, availableRanks is empty — treat all prospects as available
    const available = this.state.availableRanks.length > 0
      ? new Set(this.state.availableRanks)
      : new Set(PROSPECTS_DEDUPED.map(p => p.rank));
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

    const bestRank = await this.getBestPickForTeam(slot.currentTeam);
    if (bestRank === undefined) return { success: false, error: 'No prospects available.' };

    this.clearTimer();
    const pick = await this.recordAndAnnounce(slot, bestRank, userId, true);
    this.state.currentPickIndex++;
    await this.persist();
    const completionEmbeds = await this.advance();

    return { success: true, pick, completionEmbeds };
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

    // Invalidate any pending trades that included this pick
    this.trades.invalidateTradesForPick(slot.overall);

    // Announce in channel
    const embed = buildPickEmbed(pick, slot, TEAMS[slot.currentTeam]);
    await this.sendEmbed(embed);

    return pick;
  }

  // ─── Advance ──────────────────────────────────────────────────────────────

  private async advance(): Promise<import('discord.js').EmbedBuilder[] | undefined> {
    const maxRounds = this.state.config.rounds ?? 7;
    while (true) {
      const slot = this.state.schedule[this.state.currentPickIndex];
      if (this.state.currentPickIndex >= this.state.schedule.length || slot.round > maxRounds) {
        // Draft complete (all picks done, or configured round limit reached)
        this.state.status = 'complete';
        this.state.timerExpiresAt = null;
        await this.persist();
        // Return embeds for the caller to send as follow-ups
        const embeds: import('discord.js').EmbedBuilder[] = [];
        embeds.push(buildDraftCompleteEmbed(this.state.picks, this.state.picks.length));
        for (const abbr of Object.keys(TEAMS)) {
          embeds.push(buildTeamRosterEmbed(TEAMS[abbr], abbr, this.state.picks.filter(p => p.team === abbr), this.state.tradeHistory, this.state.schedule));
        }
        return embeds;
      }
      const userId = this.state.assignments[slot.currentTeam] ?? null;

      if (!userId && this.state.config.autoPick) {
        // CPU pick — pick best available immediately
        const bestRank = await this.getBestPickForTeam(slot.currentTeam);
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
      const embed = buildOnTheClockEmbed(slot, team, userId ? this.getTeamGMLabel(slot.currentTeam) : null, this.state.config.timerSeconds);
      await this.sendEmbed(embed, this.getTeamPings(slot.currentTeam));

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
    const result = await this.autoPick(null);
    // If this autopick ended the draft, send completion via channel (no interaction available)
    if (result.completionEmbeds?.length) {
      for (let i = 0; i < result.completionEmbeds.length; i += 10) {
        await this.sendEmbeds(result.completionEmbeds.slice(i, i + 10));
      }
    }
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
        buildTeamRosterEmbed(TEAMS[abbr], abbr, this.state.picks.filter(p => p.team === abbr), this.state.tradeHistory, this.state.schedule)
      );
      await this.sendEmbeds(embeds);
      if (i + 10 < teamAbbrs.length) await delay(800);
    }
  }

  /** Manually end the draft. Returns completion + team summary embeds for the caller to send. */
  async endDraft(): Promise<import('discord.js').EmbedBuilder[]> {
    this.state.status = 'complete';
    this.state.timerExpiresAt = null;
    this.clearTimer();
    await this.persist();

    const embeds: import('discord.js').EmbedBuilder[] = [];
    embeds.push(buildDraftCompleteEmbed(this.state.picks, this.state.picks.length));
    for (const abbr of Object.keys(TEAMS)) {
      embeds.push(buildTeamRosterEmbed(TEAMS[abbr], abbr, this.state.picks.filter(p => p.team === abbr), this.state.tradeHistory, this.state.schedule));
    }
    return embeds;
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
  resolveFuturePickRight(teamAbbr: string, year: number, round: number, originalTeam?: string): FuturePickRight | null {
    const matches = this.state.futurePickRights.filter(
      r => r.currentTeam === teamAbbr && r.year === year && r.round === round
    );
    if (matches.length === 0) return null;
    if (originalTeam) {
      return matches.find(r => r.originalTeam === originalTeam) ?? null;
    }
    // Default to the team's own pick, otherwise first match
    return matches.find(r => r.originalTeam === teamAbbr) ?? matches[0];
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

  /** Resolve a user ID to a display name, falling back to the raw ID. */
  resolveUserName(userId: string): string {
    return this.client.users.cache.get(userId)?.displayName ?? userId;
  }

  /** Build a ping string that mentions the GM and all co-managers for a team. */
  getTeamPings(teamAbbr: string): string | undefined {
    const gmId = this.state.assignments[teamAbbr];
    if (!gmId) return undefined;
    const coIds = this.getCoManagers(teamAbbr);
    const mentions = [gmId, ...coIds].map(id => `<@${id}>`);
    return mentions.join(' ');
  }

  /** Get display names for a team's GM and co-managers (for use in embeds). */
  getTeamGMLabel(teamAbbr: string): string {
    const gmId = this.state.assignments[teamAbbr];
    if (!gmId) return '_unassigned_';
    const gmName = this.resolveUserName(gmId);
    const coIds = this.getCoManagers(teamAbbr);
    if (coIds.length === 0) return gmName;
    const coNames = coIds.map(id => this.resolveUserName(id));
    return [gmName, ...coNames].join(', ');
  }

  /**
   * Build autocomplete choices for team selection, sorted alphabetically by team name.
   * Shows "Team Name - gmUsername" or "Team Name" if unassigned.
   * Filters by query matching team name, abbreviation, or GM username.
   */
  getTeamChoices(query: string, exclude?: string): Array<{ name: string; value: string }> {
    const q = query.toLowerCase();
    return Object.keys(TEAMS)
      .sort((a, b) => TEAMS[a].name.localeCompare(TEAMS[b].name))
      .filter(abbr => abbr !== exclude)
      .filter(abbr => {
        if (!q) return true;
        const gmId = this.state.assignments[abbr];
        const gmUser = gmId ? this.client.users.cache.get(gmId) : null;
        return abbr.toLowerCase().includes(q) ||
          TEAMS[abbr].name.toLowerCase().includes(q) ||
          TEAMS[abbr].city.toLowerCase().includes(q) ||
          (gmUser?.username?.toLowerCase().includes(q) ?? false);
      })
      .slice(0, 25)
      .map(abbr => {
        const gmId = this.state.assignments[abbr];
        const gmUser = gmId ? this.client.users.cache.get(gmId) : null;
        const gmLabel = gmUser ? ` - ${gmUser.displayName}` : gmId ? ` - ${gmId}` : '';
        return { name: `${TEAMS[abbr].name}${gmLabel}`.slice(0, 100), value: abbr };
      });
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


  private async refreshClock(): Promise<void> {
    const slot = this.state.schedule[this.state.currentPickIndex];
    if (!slot || this.state.status !== 'active') return;

    const userId = this.state.assignments[slot.currentTeam] ?? null;

    if (!userId && this.state.config.autoPick) {
      // New owner is CPU — pick immediately
      const bestRank = await this.getBestPickForTeam(slot.currentTeam);
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
    await this.sendEmbed(embed, this.getTeamPings(slot.currentTeam));

    if (this.state.config.timerSeconds && userId) {
      this.startTimer();
    }
  }

}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
