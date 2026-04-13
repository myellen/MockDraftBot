import {
  DraftState, DraftConfig, CompletedPick, PickSlot, PickResult,
  RegisterResult, FuturePickRight, BoardData,
} from './types';
import { TradeEngine } from './TradeEngine';
import { AIGMService } from './AIGMService';
import { TypedEventEmitter, DraftEventMap } from './events';
import type { PersistenceProvider, TimerProvider } from './interfaces';
import { buildSchedule } from './scheduleBuilder';
import { FUTURE_PICK_TRADES } from '../data/draftOrder';
import { PROSPECTS_DEDUPED, PROSPECT_BY_RANK } from '../data/prospects';
import { TEAMS } from '../data/teams';
import { ROSTERS } from '../data/rosters';
import { isOllamaConfigured } from '../llm/OllamaService';
import { smartAutopick } from '../llm/SmartAutopick';

export { formatCapAmount } from './TradeEngine';

// ─── Helpers ────────────────────────────────────────────────────────────────

export function buildFuturePickRights(): FuturePickRight[] {
  const rights: FuturePickRight[] = [];
  for (const year of [2027, 2028]) {
    for (const abbr of Object.keys(TEAMS)) {
      for (let round = 1; round <= 7; round++) {
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

export const DEFAULT_BOARD_DATA: BoardData = {
  customBoards: {},
  strategyNotes: {},
  strategyPrompts: {},
};

export const DEFAULT_STATE: DraftState = {
  schemaVersion: 1,
  status: 'idle',
  config: { channelId: null, timerSeconds: null, autoPick: true, rounds: 7, allowPlayerTrades: true, tradeAnnouncement: 'intrigue', enforceSalaryCap: false, cpuTrading: false },
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── DraftEngine ────────────────────────────────────────────────────────────

/**
 * Pure draft simulation engine. Zero discord.js imports.
 *
 * Subclass must implement four IO hooks:
 *   persistState, persistBoards, scheduleTimer, cancelTimer
 *
 * The engine emits typed events (pick:made, pick:clock, draft:complete,
 * trade:executed, etc.) that adapters subscribe to for presentation.
 */
export class DraftEngine extends TypedEventEmitter<DraftEventMap> {
  private state: DraftState;
  private boardData: BoardData;
  private timerHandle: string | null = null;
  public readonly trades: TradeEngine;
  public readonly aiGM: AIGMService;

  constructor(
    private instanceId: string,
    state: DraftState,
    boardData: BoardData,
    private persistence: PersistenceProvider,
    private timer: TimerProvider,
  ) {
    super();
    this.state = state;
    this.boardData = boardData;
    this.trades = new TradeEngine(this.state, {
      persist: () => this.persist(),
      getUserTeam: (id) => this.getUserTeam(id),
      isAuthorizedForTeam: (uid, team) => this.isAuthorizedForTeam(uid, team),
      resolvePlayer: (name, team) => this.resolvePlayer(name, team),
      clearTimer: () => this.clearTimer(),
      refreshClock: () => this.refreshClock(),
      emit: (k, p) => this.emit(k, p),
    });
    this.aiGM = new AIGMService({
      getState: () => this.state,
      getBoardData: () => this.boardData,
      getTradeManager: () => this.trades,
      emit: (k, p) => this.emit(k, p),
    });
  }

  static async load(
    id: string,
    persistence: PersistenceProvider,
    timer: TimerProvider,
  ): Promise<DraftEngine> {
    const state = (await persistence.loadState(id)) ?? { ...DEFAULT_STATE };
    const boards = (await persistence.loadBoards(id)) ?? { ...DEFAULT_BOARD_DATA };
    return new DraftEngine(id, state, boards, persistence, timer);
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private async persist(): Promise<void> {
    await this.persistence.saveState(this.instanceId, this.state);
  }

  private async persistBoardData(): Promise<void> {
    await this.persistence.saveBoards(this.instanceId, this.boardData);
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
    const existing = Object.entries(this.state.assignments).find(([, uid]) => uid === userId);
    if (existing) {
      return { success: false, error: `You already control the **${TEAMS[existing[0]].name}**. Use \`/draft unregister\` first.` };
    }
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

    this.emit('draft:started', {} as Record<string, never>);
    await this.advance();
    return { success: true };
  }

  async pause(): Promise<void> {
    if (this.state.status !== 'active') return;
    this.state.status = 'paused';
    this.clearTimer();
    await this.persist();
    this.emit('draft:paused', {} as Record<string, never>);
  }

  async resume(): Promise<void> {
    if (this.state.status !== 'paused') return;
    this.state.status = 'active';
    await this.persist();
    this.emit('draft:resumed', {} as Record<string, never>);
    await this.advance();
  }

  async reset(): Promise<void> {
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
    this.emit('draft:reset', {} as Record<string, never>);
  }

  async wipe(): Promise<void> {
    this.clearTimer();
    this.state = { ...DEFAULT_STATE };
    this.boardData = { ...DEFAULT_BOARD_DATA };
    await this.persist();
    await this.persistBoardData();
    this.emit('draft:reset', {} as Record<string, never>);
  }

  // ─── Picking ──────────────────────────────────────────────────────────────

  async makePick(userId: string, prospectRank: number): Promise<PickResult> {
    if (this.state.status !== 'active') {
      return { success: false, error: 'The draft is not currently active.' };
    }
    const slot = this.state.schedule[this.state.currentPickIndex];
    if (!slot) return { success: false, error: 'No pick available.' };

    if (!this.isAuthorizedForTeam(userId, slot.currentTeam)) {
      const onClock = TEAMS[slot.currentTeam]?.name ?? slot.currentTeam;
      return { success: false, error: `It's not your pick. The **${onClock}** are on the clock.` };
    }

    if (!this.state.availableRanks.includes(prospectRank)) {
      return { success: false, error: 'That player has already been drafted.' };
    }

    this.clearTimer();
    const pick = this.recordPick(slot, prospectRank, userId, false);
    this.state.currentPickIndex++;
    await this.persist();
    void this.aiGM.onPickMade(pick);
    const draftComplete = await this.advance();

    return { success: true, pick, draftComplete };
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
    const pick = this.recordPick(slot, prospectRank, 'admin', false);
    this.state.currentPickIndex++;
    await this.persist();
    const draftComplete = await this.advance();

    return { success: true, pick, draftComplete };
  }

  async autoPick(userId: string | null): Promise<PickResult> {
    if (this.state.status !== 'active') {
      return { success: false, error: 'The draft is not currently active.' };
    }
    const slot = this.state.schedule[this.state.currentPickIndex];
    if (!slot) return { success: false, error: 'No pick available.' };

    if (userId !== null && !this.isAuthorizedForTeam(userId, slot.currentTeam)) {
      const onClock = TEAMS[slot.currentTeam]?.name ?? slot.currentTeam;
      return { success: false, error: `It's not your pick. The **${onClock}** are on the clock.` };
    }

    const bestRank = await this.getBestPickForTeam(slot.currentTeam);
    if (bestRank === undefined) return { success: false, error: 'No prospects available.' };

    this.clearTimer();
    const pick = this.recordPick(slot, bestRank, userId, true);
    this.state.currentPickIndex++;
    await this.persist();
    const draftComplete = await this.advance();

    return { success: true, pick, draftComplete };
  }

  /**
   * Record a pick into state and emit the pick:made event.
   * Replaces the old recordAndAnnounce — no embed building.
   */
  private recordPick(
    slot: PickSlot,
    prospectRank: number,
    userId: string | null,
    autoPicked: boolean
  ): CompletedPick {
    const prospect = PROSPECT_BY_RANK.get(prospectRank)!;

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
    this.trades.invalidateTradesForPick(slot.overall);
    this.emit('pick:made', { pick, slot });

    return pick;
  }

  // ─── Advance ──────────────────────────────────────────────────────────────

  /**
   * Advance the draft to the next actionable state.
   * Returns true if the draft completed during this advance.
   */
  private async advance(): Promise<boolean> {
    const maxRounds = this.state.config.rounds ?? 7;
    while (true) {
      const slot = this.state.schedule[this.state.currentPickIndex];
      if (this.state.currentPickIndex >= this.state.schedule.length || slot.round > maxRounds) {
        // Draft complete
        this.state.status = 'complete';
        this.state.timerExpiresAt = null;
        await this.persist();
        this.emit('draft:complete', { picks: this.state.picks });
        return true;
      }
      const userId = this.state.assignments[slot.currentTeam] ?? null;

      if (!userId && this.state.config.autoPick) {
        // CPU turn — let AI GM try to trade first
        const traded = await this.aiGM.onCPUTurn(slot);
        if (traded) {
          // Trade changed the clock — re-evaluate from the top
          await delay(2000);
          continue;
        }

        // No trade — pick best available
        const bestRank = await this.getBestPickForTeam(slot.currentTeam);
        if (bestRank === undefined) break;
        const pick = this.recordPick(slot, bestRank, null, true);
        this.state.currentPickIndex++;
        await this.persist();
        // Notify AI GM of the pick
        void this.aiGM.onPickMade(pick);
        await delay(1500);
        continue;
      }

      // Human's turn (or CPU without autoPick) — emit on-the-clock event
      this.emit('pick:clock', { slot, teamAbbr: slot.currentTeam });

      if (this.state.config.timerSeconds && userId) {
        this.startTimer();
      }

      // CPU GMs work phones while human decides (fire-and-forget)
      if (userId) void this.aiGM.onHumanTurn(slot);

      break;
    }
    return false;
  }

  // ─── Timer ────────────────────────────────────────────────────────────────

  private startTimer(): void {
    const seconds = this.state.config.timerSeconds!;
    this.state.timerExpiresAt = Date.now() + seconds * 1000;
    this.timerHandle = this.timer.schedule(seconds * 1000, () => this.onTimerExpired());
  }

  clearTimer(): void {
    if (this.timerHandle !== null) {
      this.timer.cancel(this.timerHandle);
      this.timerHandle = null;
    }
    this.state.timerExpiresAt = null;
  }

  private async onTimerExpired(): Promise<void> {
    if (this.state.timerExpiresAt === null) return;
    if (this.state.status !== 'active') return;
    console.log(`⏰ Timer expired for pick ${this.state.currentPickIndex + 1}`);
    this.state.timerExpiresAt = null;
    await this.autoPick(null);
    // draft:complete event fires inside autoPick→advance if the draft ended
  }

  restoreTimer(): void {
    if (this.state.status !== 'active' || this.state.timerExpiresAt === null) return;
    const remaining = this.state.timerExpiresAt - Date.now();
    if (remaining <= 0) {
      this.timerHandle = this.timer.schedule(0, () => this.onTimerExpired());
    } else {
      this.timerHandle = this.timer.schedule(remaining, () => this.onTimerExpired());
    }
  }

  // ─── End draft (manual) ───────────────────────────────────────────────────

  async endDraft(): Promise<void> {
    this.state.status = 'complete';
    this.state.timerExpiresAt = null;
    this.clearTimer();
    await this.persist();
    this.emit('draft:complete', { picks: this.state.picks });
  }

  // ─── Custom Board / Strategy ──────────────────────────────────────────────

  private async getBestPickForTeam(teamAbbr: string): Promise<number | undefined> {
    const available = new Set(this.state.availableRanks);

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

    const board = this.boardData.customBoards[teamAbbr];
    if (board?.length) {
      const pick = board.find(rank => available.has(rank));
      if (pick !== undefined) return pick;
    }

    return this.state.availableRanks[0];
  }

  submitBoard(teamAbbr: string, rankedNames: string[]): { matched: number; unmatched: string[] } {
    const nameToRank = new Map<string, number>();
    for (const [rank, p] of PROSPECT_BY_RANK) nameToRank.set(p.name.toLowerCase(), rank);

    const ranks: number[] = [];
    const unmatched: string[] = [];
    for (const rawName of rankedNames) {
      const name = rawName.replace(/\s*\(.*\)\s*$/, '').trim();
      const rank = nameToRank.get(name.toLowerCase());
      if (rank !== undefined) ranks.push(rank);
      else unmatched.push(rawName);
    }
    this.boardData.customBoards[teamAbbr] = ranks;
    void this.persistBoardData();
    return { matched: ranks.length, unmatched };
  }

  clearBoard(teamAbbr: string, what: 'board' | 'strategy' | 'all'): void {
    if (what === 'board' || what === 'all') delete this.boardData.customBoards[teamAbbr];
    if (what === 'strategy' || what === 'all') delete this.boardData.strategyPrompts[teamAbbr];
    if (what === 'all') delete this.boardData.strategyNotes[teamAbbr];
    void this.persistBoardData();
  }

  getCustomBoard(teamAbbr: string): number[] {
    return this.boardData.customBoards[teamAbbr] ?? [];
  }

  getStrategyPrompt(teamAbbr: string): string | undefined {
    return this.boardData.strategyPrompts[teamAbbr];
  }

  setStrategyPrompt(teamAbbr: string, prompt: string): void {
    this.boardData.strategyPrompts[teamAbbr] = prompt;
    void this.persistBoardData();
  }

  clearStrategyPrompt(teamAbbr: string): void {
    delete this.boardData.strategyPrompts[teamAbbr];
    void this.persistBoardData();
  }

  getStrategyNotes(teamAbbr: string): string[] {
    return this.boardData.strategyNotes[teamAbbr] ?? [];
  }

  addStrategyNote(teamAbbr: string, note: string, maxNotes = 5): void {
    const notes = this.boardData.strategyNotes[teamAbbr] ?? [];
    notes.push(note);
    if (notes.length > maxNotes) notes.splice(0, notes.length - maxNotes);
    this.boardData.strategyNotes[teamAbbr] = notes;
    void this.persistBoardData();
  }

  getMyBoardPage(teamAbbr: string, page: number, pageSize = 20): {
    entries: { boardPos: number; rank: number; name: string; pos: string; school: string; available: boolean }[];
    total: number;
    totalPages: number;
    page: number;
  } {
    const board = this.boardData.customBoards[teamAbbr] ?? [];
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

  resolvePlayer(nameQuery: string, teamAbbr: string): string | null {
    const q = nameQuery.toLowerCase();
    const overrideTeam = this.state.playerOwnership[q];
    if (overrideTeam !== undefined) {
      return overrideTeam === teamAbbr ? nameQuery : null;
    }
    const roster = ROSTERS[teamAbbr] ?? [];
    const match = roster.find(p => p.name.toLowerCase().includes(q));
    return match ? match.name : null;
  }

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

  searchRosterPlayers(teamAbbr: string, query: string): Array<{ name: string; pos: string }> {
    const q = query.toLowerCase();
    const baseRoster = ROSTERS[teamAbbr] ?? [];
    const tradedIn = Object.entries(this.state.playerOwnership)
      .filter(([, t]) => t === teamAbbr)
      .map(([nameLower]) => {
        for (const players of Object.values(ROSTERS)) {
          const p = players.find(pl => pl.name.toLowerCase() === nameLower);
          if (p) return p;
        }
        return null;
      })
      .filter(Boolean) as Array<{ name: string; pos: string; number: string | null }>;

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

  resolveFuturePickRight(teamAbbr: string, year: number, round: number, originalTeam?: string): FuturePickRight | null {
    const matches = this.state.futurePickRights.filter(
      r => r.currentTeam === teamAbbr && r.year === year && r.round === round
    );
    if (matches.length === 0) return null;
    if (originalTeam) {
      return matches.find(r => r.originalTeam === originalTeam) ?? null;
    }
    return matches.find(r => r.originalTeam === teamAbbr) ?? matches[0];
  }

  resolvePickByRoundPick(round: number, roundPick: number): number | null {
    const schedule = this.state.schedule.length > 0 ? this.state.schedule : buildSchedule();
    const slot = schedule.find(s => s.round === round && s.roundPick === roundPick);
    return slot?.overall ?? null;
  }

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

  // ─── Rewind ───────────────────────────────────────────────────────────────

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

  // ─── Admin Operations ─────────────────────────────────────────────────────

  async adminAssignTeam(teamAbbr: string, userId: string): Promise<{ success: boolean; error?: string }> {
    if (!TEAMS[teamAbbr]) return { success: false, error: `Unknown team: ${teamAbbr}` };
    for (const abbr of Object.keys(this.state.assignments)) {
      if (this.state.assignments[abbr] === userId) delete this.state.assignments[abbr];
    }
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

  // ─── Refresh Clock (after trade) ─────────────────────────────────────────

  private async refreshClock(): Promise<void> {
    const slot = this.state.schedule[this.state.currentPickIndex];
    if (!slot || this.state.status !== 'active') return;

    const userId = this.state.assignments[slot.currentTeam] ?? null;

    if (!userId && this.state.config.autoPick) {
      const bestRank = await this.getBestPickForTeam(slot.currentTeam);
      if (bestRank === undefined) return;
      this.recordPick(slot, bestRank, null, true);
      this.state.currentPickIndex++;
      await this.persist();
      await delay(1500);
      await this.advance();
      return;
    }

    this.emit('pick:clock', { slot, teamAbbr: slot.currentTeam });

    if (this.state.config.timerSeconds && userId) {
      this.startTimer();
    }
  }
}
