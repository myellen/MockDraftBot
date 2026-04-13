import { Client, TextChannel, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  DraftState, DraftConfig, CancelledTrade, PendingTrade,
  FuturePickRight, BoardData,
} from '../engine/types';
import { DraftEngine, DEFAULT_STATE, DEFAULT_BOARD_DATA } from '../engine/DraftEngine';
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

// ─── State loading helpers (called before super()) ──────────────────────────

function buildFuturePickRights(): FuturePickRight[] {
  // Re-import inline to avoid circular dependency at top level
  const { FUTURE_PICK_TRADES } = require('../data/draftOrder');
  const rights: FuturePickRight[] = [];
  for (const year of [2027, 2028]) {
    for (const abbr of Object.keys(TEAMS)) {
      for (let round = 1; round <= 7; round++) {
        const trade = FUTURE_PICK_TRADES.find(
          (t: { year: number; round: number; originalTeam: string }) =>
            t.year === year && t.round === round && t.originalTeam === abbr
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

async function loadStateFromFile(guildId: string): Promise<DraftState> {
  try {
    const raw = await fs.readFile(statePath(guildId), 'utf-8');
    const parsed = JSON.parse(raw) as DraftState;
    if (parsed.schemaVersion !== 1) {
      console.warn('Draft state schema mismatch — resetting to default');
      return { ...DEFAULT_STATE };
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
    return { ...DEFAULT_STATE };
  }
}

async function loadBoardsFromFile(guildId: string): Promise<BoardData> {
  try {
    const raw = await fs.readFile(boardPath(guildId), 'utf-8');
    const parsed = JSON.parse(raw) as BoardData;
    return {
      customBoards: parsed.customBoards ?? {},
      strategyNotes: parsed.strategyNotes ?? {},
      strategyPrompts: (parsed as any).strategyPrompts ?? {},
    };
  } catch {
    return { ...DEFAULT_BOARD_DATA };
  }
}

// ─── DraftManager (Discord adapter) ─────────────────────────────────────────

/**
 * Discord facade over DraftEngine. Extends DraftEngine so commands can call
 * engine methods directly (no pass-through). Adds:
 *   - File-based persistence (implements the abstract IO hooks)
 *   - setTimeout-based timer
 *   - Discord display helpers (resolveUserName, getTeamPings, etc.)
 *   - Event subscriptions that send embeds to the draft channel
 */
export class DraftManager extends DraftEngine {
  private client: Client;
  private guildId: string;

  private constructor(client: Client, guildId: string, state: DraftState, boardData: BoardData) {
    super(state, boardData);
    this.client = client;
    this.guildId = guildId;
    this.bindEvents();
  }

  static async load(client: Client, guildId: string): Promise<DraftManager> {
    const state = await loadStateFromFile(guildId);
    const boardData = await loadBoardsFromFile(guildId);
    const manager = new DraftManager(client, guildId, state, boardData);

    // Restore timer if draft was active on restart
    client.once('ready', () => manager.restoreTimer());

    return manager;
  }

  // ─── IO hook implementations ──────────────────────────────────────────────

  protected async persistState(state: DraftState): Promise<void> {
    const p = statePath(this.guildId);
    const tmp = p + '.tmp';
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tmp, p);
  }

  protected async persistBoards(boards: BoardData): Promise<void> {
    const p = boardPath(this.guildId);
    const tmp = p + '.tmp';
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(boards, null, 2), 'utf-8');
    await fs.rename(tmp, p);
  }

  protected scheduleTimer(ms: number, cb: () => void): NodeJS.Timeout {
    return setTimeout(cb, ms);
  }

  protected cancelTimer(handle: unknown): void {
    clearTimeout(handle as NodeJS.Timeout);
  }

  // ─── Event subscriptions → Discord embeds ─────────────────────────────────

  private bindEvents(): void {
    this.on('pick:made', ({ pick, slot }) => {
      const embed = buildPickEmbed(pick, slot, TEAMS[slot.currentTeam]);
      void this.sendEmbed(embed);
    });

    this.on('pick:clock', ({ slot, teamAbbr }) => {
      const userId = this.getState().assignments[teamAbbr] ?? null;
      const embed = buildOnTheClockEmbed(
        slot,
        TEAMS[teamAbbr],
        userId ? this.getTeamGMLabel(teamAbbr) : null,
        this.getConfig().timerSeconds,
      );
      void this.sendEmbed(embed, this.getTeamPings(teamAbbr));
    });

    this.on('trade:executed', ({ trade }) => {
      const embed = buildTradeExecutedEmbed(trade, TEAMS, this.getState().schedule);
      void this.sendEmbed(embed);
    });

    this.on('draft:complete', ({ picks }) => {
      void this.sendCompletion(picks);
    });

    this.on('cpu-offer:sent', ({ offer }) => {
      void this.sendCPUOfferEmbed(offer);
    });

    this.on('trade:chatter', ({ reasoning }) => {
      const embed = new EmbedBuilder()
        .setDescription(reasoning)
        .setColor(0x95a5a6)
        .setFooter({ text: 'Trade Market Chatter' });
      void this.sendEmbed(embed);
    });
  }

  // ─── Discord display helpers ──────────────────────────────────────────────

  /** Resolve a user ID to a display name, falling back to the raw ID. */
  resolveUserName(userId: string): string {
    return this.client.users.cache.get(userId)?.displayName ?? userId;
  }

  /** Build a ping string that mentions the GM and all co-managers for a team. */
  getTeamPings(teamAbbr: string): string | undefined {
    const gmId = this.getState().assignments[teamAbbr];
    if (!gmId) return undefined;
    const coIds = this.getCoManagers(teamAbbr);
    const mentions = [gmId, ...coIds].map(id => `<@${id}>`);
    return mentions.join(' ');
  }

  /** Get display names for a team's GM and co-managers (for use in embeds). */
  getTeamGMLabel(teamAbbr: string): string {
    const gmId = this.getState().assignments[teamAbbr];
    if (!gmId) return '_unassigned_';
    const gmName = this.resolveUserName(gmId);
    const coIds = this.getCoManagers(teamAbbr);
    if (coIds.length === 0) return gmName;
    const coNames = coIds.map(id => this.resolveUserName(id));
    return [gmName, ...coNames].join(', ');
  }

  /**
   * Build autocomplete choices for team selection, sorted alphabetically.
   * Shows "Team Name - gmUsername" or "Team Name" if unassigned.
   */
  getTeamChoices(query: string, exclude?: string): Array<{ name: string; value: string }> {
    const q = query.toLowerCase();
    return Object.keys(TEAMS)
      .sort((a, b) => TEAMS[a].name.localeCompare(TEAMS[b].name))
      .filter(abbr => abbr !== exclude)
      .filter(abbr => {
        if (!q) return true;
        const gmId = this.getState().assignments[abbr];
        const gmUser = gmId ? this.client.users.cache.get(gmId) : null;
        return abbr.toLowerCase().includes(q) ||
          TEAMS[abbr].name.toLowerCase().includes(q) ||
          TEAMS[abbr].city.toLowerCase().includes(q) ||
          (gmUser?.username?.toLowerCase().includes(q) ?? false);
      })
      .slice(0, 25)
      .map(abbr => {
        const gmId = this.getState().assignments[abbr];
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

  private async sendMessage(opts: { embeds?: EmbedBuilder[]; content?: string; components?: any }): Promise<void> {
    const channelId = this.getConfig().channelId;
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

  private async sendCPUOfferEmbed(offer: CPUOffer): Promise<void> {
    const state = this.getState();
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

  private async sendEmbedWithComponents(
    embed: EmbedBuilder,
    components?: ActionRowBuilder<ButtonBuilder>[],
  ): Promise<void> {
    await this.sendMessage({ embeds: [embed], components: components as any });
  }

  private async sendCompletion(picks: import('../engine/types').CompletedPick[]): Promise<void> {
    const state = this.getState();
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
