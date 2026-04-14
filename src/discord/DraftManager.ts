import { Client, TextChannel, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  DraftState, DraftConfig, CancelledTrade, PendingTrade,
  FuturePickRight, BoardData, CompletedPick,
} from '../engine/types';
import { DraftEngine, DEFAULT_STATE, DEFAULT_BOARD_DATA, buildFuturePickRights } from '../engine/DraftEngine';
import type { PersistenceProvider, TimerProvider } from '../engine/interfaces';
import type { CPUOffer } from '../engine/AIGMService';
import { getGMProfile } from '../data/gmProfiles';
import { TEAMS } from '../data/teams';
import {
  buildPickEmbed, buildOnTheClockEmbed, buildDraftCompleteEmbed,
  buildTeamRosterEmbed, buildTradeExecutedEmbed,
} from '../utils/embeds';

export { formatCapAmount } from '../engine/TradeEngine';

// ─── File paths ─────────────────────────────────────────────────────────────

function statePath(guildId: string): string {
  return path.join(__dirname, `../../data/draft-state-${guildId}.json`);
}

function boardPath(guildId: string): string {
  return path.join(__dirname, `../../data/draft-boards-${guildId}.json`);
}

// ─── DraftManager (Discord adapter) ─────────────────────────────────────────

/**
 * Discord facade over DraftEngine. Composes a DraftEngine instance and
 * delegates all engine calls. Implements PersistenceProvider (file-based)
 * and TimerProvider (setTimeout). Subscribes to engine events to send
 * Discord embeds.
 */
export class DraftManager implements PersistenceProvider, TimerProvider {
  private engine!: DraftEngine;
  private client: Client;
  private guildId: string;
  private timerMap = new Map<string, NodeJS.Timeout>();
  private timerCounter = 0;

  private constructor(client: Client, guildId: string) {
    this.client = client;
    this.guildId = guildId;
  }

  static async load(client: Client, guildId: string): Promise<DraftManager> {
    const m = new DraftManager(client, guildId);
    const state = (await m.loadState(guildId)) ?? { ...DEFAULT_STATE };
    const boardData = (await m.loadBoards(guildId)) ?? { ...DEFAULT_BOARD_DATA };
    m.engine = new DraftEngine(guildId, state, boardData, m, m);
    m.bindEvents();
    client.once('ready', () => m.engine.restoreTimer());
    return m;
  }

  // ─── PersistenceProvider implementation ────────────────────────────────────

  async loadState(id: string): Promise<DraftState | null> {
    try {
      const raw = await fs.readFile(statePath(id), 'utf-8');
      const parsed = JSON.parse(raw) as DraftState;
      if (parsed.schemaVersion !== 1) {
        console.warn('Draft state schema mismatch — resetting to default');
        return null;
      }
      // Backfill fields added after initial schema
      const r = parsed as unknown as Record<string, unknown>;
      const state: DraftState = {
        ...parsed,
        coManagers: (r.coManagers as Record<string, string[]> | undefined) ?? {},
        pendingTrades: (r.pendingTrades as PendingTrade[] | undefined) ?? [],
        tradeHistory: (r.tradeHistory as PendingTrade[] | undefined) ?? [],
        cancelledTrades: (r.cancelledTrades as CancelledTrade[] | undefined) ?? [],
        playerOwnership: (r.playerOwnership as Record<string, string> | undefined) ?? {},
        futurePickRights: (r.futurePickRights as FuturePickRight[] | undefined) ?? buildFuturePickRights(),
        config: {
          ...(parsed.config as DraftConfig),
          rounds: (parsed.config as DraftConfig).rounds ?? 7,
          allowPlayerTrades: (parsed.config as DraftConfig).allowPlayerTrades ?? true,
          tradeAnnouncement: (parsed.config as DraftConfig).tradeAnnouncement ?? 'intrigue',
          enforceSalaryCap: (parsed.config as DraftConfig).enforceSalaryCap ?? false,
          cpuTrading: (parsed.config as DraftConfig).cpuTrading ?? false,
          simulationMode: (parsed.config as DraftConfig).simulationMode ?? false,
          gmExtraResearch: (parsed.config as DraftConfig).gmExtraResearch ?? false,
        },
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
      return state;
    } catch {
      return null;
    }
  }

  async saveState(id: string, state: DraftState): Promise<void> {
    const p = statePath(id);
    const tmp = p + '.tmp';
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tmp, p);
  }

  async loadBoards(id: string): Promise<BoardData | null> {
    try {
      const raw = await fs.readFile(boardPath(id), 'utf-8');
      const parsed = JSON.parse(raw) as BoardData;
      return {
        customBoards: parsed.customBoards ?? {},
        strategyNotes: parsed.strategyNotes ?? {},
        strategyPrompts: (parsed as any).strategyPrompts ?? {},
      };
    } catch {
      return null;
    }
  }

  async saveBoards(id: string, boards: BoardData): Promise<void> {
    const p = boardPath(id);
    const tmp = p + '.tmp';
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(boards, null, 2), 'utf-8');
    await fs.rename(tmp, p);
  }

  // ─── TimerProvider implementation ─────────────────────────────────────────

  schedule(ms: number, cb: () => void): string {
    const id = String(++this.timerCounter);
    this.timerMap.set(id, setTimeout(cb, ms));
    return id;
  }

  cancel(timerId: string): void {
    const handle = this.timerMap.get(timerId);
    if (handle) {
      clearTimeout(handle);
      this.timerMap.delete(timerId);
    }
  }

  // ─── Engine delegation ────────────────────────────────────────────────────

  get trades() { return this.engine.trades; }
  get aiGM() { return this.engine.aiGM; }

  // State & config
  getState() { return this.engine.getState(); }
  getConfig() { return this.engine.getConfig(); }
  getCurrentSlot() { return this.engine.getCurrentSlot(); }
  getTimeRemaining() { return this.engine.getTimeRemaining(); }

  // User / team identity
  getUserTeam(userId: string) { return this.engine.getUserTeam(userId); }
  isPrimaryGM(userId: string, teamAbbr: string) { return this.engine.isPrimaryGM(userId, teamAbbr); }
  isAuthorizedForTeam(userId: string, teamAbbr: string) { return this.engine.isAuthorizedForTeam(userId, teamAbbr); }
  getUnassignedTeams() { return this.engine.getUnassignedTeams(); }
  getCoManagers(teamAbbr: string) { return this.engine.getCoManagers(teamAbbr); }

  // Draft lifecycle
  setup(config: Partial<DraftConfig>) { return this.engine.setup(config); }
  start() { return this.engine.start(); }
  pause() { return this.engine.pause(); }
  resume() { return this.engine.resume(); }
  reset() { return this.engine.reset(); }
  wipe() { return this.engine.wipe(); }
  endDraft() { return this.engine.endDraft(); }
  rewind(round: number, roundPick: number) { return this.engine.rewind(round, roundPick); }

  // Registration & admin
  registerTeam(teamAbbr: string, userId: string) { return this.engine.registerTeam(teamAbbr, userId); }
  unregisterTeam(userId: string) { return this.engine.unregisterTeam(userId); }
  addCoManager(requesterId: string, coManagerId: string) { return this.engine.addCoManager(requesterId, coManagerId); }
  removeCoManager(requesterId: string, coManagerId: string) { return this.engine.removeCoManager(requesterId, coManagerId); }
  adminAssignTeam(teamAbbr: string, userId: string) { return this.engine.adminAssignTeam(teamAbbr, userId); }
  adminAddCoManager(teamAbbr: string, userId: string) { return this.engine.adminAddCoManager(teamAbbr, userId); }
  adminMakePick(prospectRank: number) { return this.engine.adminMakePick(prospectRank); }

  // Picking
  makePick(userId: string, prospectRank: number) { return this.engine.makePick(userId, prospectRank); }
  autoPick(userId: string | null) { return this.engine.autoPick(userId); }

  // Prospects & roster queries
  searchProspects(query: string, pos?: string) { return this.engine.searchProspects(query, pos); }
  getAvailableProspects(pos?: string, page?: number, pageSize?: number) { return this.engine.getAvailableProspects(pos, page, pageSize); }
  getTeamPicks(teamAbbr: string) { return this.engine.getTeamPicks(teamAbbr); }
  getLastNPicks(n: number) { return this.engine.getLastNPicks(n); }
  getFullRoster(teamAbbr: string) { return this.engine.getFullRoster(teamAbbr); }
  resolvePlayer(nameQuery: string, teamAbbr: string) { return this.engine.resolvePlayer(nameQuery, teamAbbr); }
  resolvePlayerByJersey(teamAbbr: string, jersey: string) { return this.engine.resolvePlayerByJersey(teamAbbr, jersey); }
  searchRosterPlayers(teamAbbr: string, query: string) { return this.engine.searchRosterPlayers(teamAbbr, query); }
  resolvePickByRoundPick(round: number, roundPick: number) { return this.engine.resolvePickByRoundPick(round, roundPick); }

  // Future picks
  getFuturePicksForTeam(teamAbbr: string) { return this.engine.getFuturePicksForTeam(teamAbbr); }
  getFuturePickRightsForTeam(teamAbbr: string) { return this.engine.getFuturePickRightsForTeam(teamAbbr); }
  resolveFuturePickRight(teamAbbr: string, year: number, round: number, originalTeam?: string) {
    return this.engine.resolveFuturePickRight(teamAbbr, year, round, originalTeam);
  }

  // Board & strategy
  submitBoard(teamAbbr: string, rankedNames: string[]) { return this.engine.submitBoard(teamAbbr, rankedNames); }
  clearBoard(teamAbbr: string, what: 'board' | 'strategy' | 'all') { return this.engine.clearBoard(teamAbbr, what); }
  getCustomBoard(teamAbbr: string) { return this.engine.getCustomBoard(teamAbbr); }
  getMyBoardPage(teamAbbr: string, page: number, pageSize?: number) { return this.engine.getMyBoardPage(teamAbbr, page, pageSize); }
  getStrategyPrompt(teamAbbr: string) { return this.engine.getStrategyPrompt(teamAbbr); }
  setStrategyPrompt(teamAbbr: string, prompt: string) { return this.engine.setStrategyPrompt(teamAbbr, prompt); }
  getStrategyNotes(teamAbbr: string) { return this.engine.getStrategyNotes(teamAbbr); }
  addStrategyNote(teamAbbr: string, note: string, maxNotes?: number) { return this.engine.addStrategyNote(teamAbbr, note, maxNotes); }

  // ─── Event subscriptions → Discord embeds ─────────────────────────────────

  private bindEvents(): void {
    this.engine.on('pick:made', ({ pick, slot }) => {
      const embed = buildPickEmbed(pick, slot, TEAMS[slot.currentTeam]);
      void this.sendEmbed(embed);
    });

    this.engine.on('pick:clock', ({ slot, teamAbbr }) => {
      const userId = this.engine.getState().assignments[teamAbbr] ?? null;
      const embed = buildOnTheClockEmbed(
        slot,
        TEAMS[teamAbbr],
        userId ? this.getTeamGMLabel(teamAbbr) : null,
        this.engine.getConfig().timerSeconds,
      );
      void this.sendEmbed(embed, this.getTeamPings(teamAbbr));
    });

    this.engine.on('trade:executed', ({ trade }) => {
      const embed = buildTradeExecutedEmbed(trade, TEAMS, this.engine.getState().schedule);
      void this.sendEmbed(embed);
    });

    this.engine.on('draft:complete', ({ picks }) => {
      void this.sendCompletion(picks);
    });

    this.engine.on('cpu-offer:sent', ({ offer }) => {
      void this.sendCPUOfferEmbed(offer);
    });

    this.engine.on('trade:chatter', ({ reasoning }) => {
      const embed = new EmbedBuilder()
        .setDescription(reasoning)
        .setColor(0x95a5a6)
        .setFooter({ text: 'Trade Market Chatter' });
      void this.sendEmbed(embed);
    });
  }

  // ─── Discord display helpers ──────────────────────────────────────────────

  resolveUserName(userId: string): string {
    return this.client.users.cache.get(userId)?.displayName ?? userId;
  }

  getTeamPings(teamAbbr: string): string | undefined {
    const gmId = this.engine.getState().assignments[teamAbbr];
    if (!gmId) return undefined;
    const coIds = this.engine.getCoManagers(teamAbbr);
    const mentions = [gmId, ...coIds].map(id => `<@${id}>`);
    return mentions.join(' ');
  }

  getTeamGMLabel(teamAbbr: string): string {
    const gmId = this.engine.getState().assignments[teamAbbr];
    if (!gmId) return '_unassigned_';
    const gmName = this.resolveUserName(gmId);
    const coIds = this.engine.getCoManagers(teamAbbr);
    if (coIds.length === 0) return gmName;
    const coNames = coIds.map(id => this.resolveUserName(id));
    return [gmName, ...coNames].join(', ');
  }

  getTeamChoices(query: string, exclude?: string): Array<{ name: string; value: string }> {
    const q = query.toLowerCase();
    return Object.keys(TEAMS)
      .sort((a, b) => TEAMS[a].name.localeCompare(TEAMS[b].name))
      .filter(abbr => abbr !== exclude)
      .filter(abbr => {
        if (!q) return true;
        const gmId = this.engine.getState().assignments[abbr];
        const gmUser = gmId ? this.client.users.cache.get(gmId) : null;
        return abbr.toLowerCase().includes(q) ||
          TEAMS[abbr].name.toLowerCase().includes(q) ||
          TEAMS[abbr].city.toLowerCase().includes(q) ||
          (gmUser?.username?.toLowerCase().includes(q) ?? false);
      })
      .slice(0, 25)
      .map(abbr => {
        const gmId = this.engine.getState().assignments[abbr];
        const gmUser = gmId ? this.client.users.cache.get(gmId) : null;
        const gmLabel = gmUser ? ` - ${gmUser.displayName}` : gmId ? ` - ${gmId}` : '';
        return { name: `${TEAMS[abbr].name}${gmLabel}`.slice(0, 100), value: abbr };
      });
  }

  // ─── Channel sending ──────────────────────────────────────────────────────

  private async sendEmbed(embed: import('discord.js').EmbedBuilder, content?: string): Promise<void> {
    await this.sendMessage({ embeds: [embed], content });
  }

  private async sendEmbeds(embeds: import('discord.js').EmbedBuilder[]): Promise<void> {
    await this.sendMessage({ embeds });
  }

  private async sendEmbedWithComponents(
    embed: EmbedBuilder,
    components?: ActionRowBuilder<ButtonBuilder>[],
  ): Promise<void> {
    await this.sendMessage({ embeds: [embed], components: components as any });
  }

  private async sendCPUOfferEmbed(offer: CPUOffer): Promise<void> {
    const state = this.engine.getState();
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

    const embed = new EmbedBuilder()
      .setTitle(`Trade Offer from ${proposerName}`)
      .setDescription(`*"${offer.pitch}"*`)
      .addFields(
        { name: `${proposerName} sends`, value: offerLines.join('\n') || 'Nothing', inline: true },
        { name: `${receiverName} sends`, value: requestLines.join('\n') || 'Nothing', inline: true },
      )
      .setColor(TEAMS[offer.proposerTeam]?.color ?? 0x888888)
      .setFooter({ text: `AI GM (${profile.archetype}) • Offer expires in 2 min` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`cpu-offer-accept:${offer.id}`)
        .setLabel('Accept Trade')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`cpu-offer-decline:${offer.id}`)
        .setLabel('Decline')
        .setStyle(ButtonStyle.Danger),
    );

    await this.sendEmbedWithComponents(embed, [row]);
  }

  private async sendMessage(opts: { embeds?: EmbedBuilder[]; content?: string; components?: any }): Promise<void> {
    const channelId = this.engine.getConfig().channelId;
    if (!channelId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased() && 'send' in channel) {
        await (channel as TextChannel).send(opts);
      }
    } catch (err) {
      console.error('Failed to send message:', err);
    }
  }

  private async sendCompletion(picks: CompletedPick[]): Promise<void> {
    const state = this.engine.getState();
    const embeds: import('discord.js').EmbedBuilder[] = [];
    embeds.push(buildDraftCompleteEmbed(picks, picks.length));
    for (const abbr of Object.keys(TEAMS)) {
      embeds.push(buildTeamRosterEmbed(
        TEAMS[abbr], abbr,
        picks.filter(p => p.team === abbr),
        state.tradeHistory, state.schedule,
      ));
    }
    for (let i = 0; i < embeds.length; i += 10) {
      await this.sendEmbeds(embeds.slice(i, i + 10));
      if (i + 10 < embeds.length) {
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }
}
