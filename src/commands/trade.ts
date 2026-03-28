import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
} from 'discord.js';
import { DraftManager } from '../draft/DraftManager';
import { TEAMS } from '../data/teams';
import { buildPendingTradesEmbed } from '../utils/embeds';
import { isAdmin } from '../utils/permissions';

export const data = new SlashCommandBuilder()
  .setName('trade')
  .setDescription('Propose, accept, or decline pick trades')
  .addSubcommand(sub => sub
    .setName('propose')
    .setDescription('Propose a trade to another GM')
    .addUserOption(opt => opt
      .setName('to')
      .setDescription('The GM you want to trade with')
      .setRequired(true)
    )
    .addStringOption(opt => opt
      .setName('offer')
      .setDescription('Picks you give up — pick one, then type comma + next # to add more (e.g. 5,37)')
      .setRequired(false)
      .setAutocomplete(true)
    )
    .addStringOption(opt => opt
      .setName('receive')
      .setDescription('Their picks you want — pick one, then type comma + next # to add more (e.g. 33,65)')
      .setRequired(false)
      .setAutocomplete(true)
    )
    .addStringOption(opt => opt
      .setName('offer-players')
      .setDescription('Players you give up — pick one, then type comma + name to add more')
      .setRequired(false)
      .setAutocomplete(true)
    )
    .addStringOption(opt => opt
      .setName('receive-players')
      .setDescription('Players you want — pick one, then type comma + name to add more')
      .setRequired(false)
      .setAutocomplete(true)
    )
    .addStringOption(opt => opt
      .setName('offer-future')
      .setDescription('Future picks you give — pick one, then type comma + year/round to add more')
      .setRequired(false)
      .setAutocomplete(true)
    )
    .addStringOption(opt => opt
      .setName('receive-future')
      .setDescription('Their future picks you want — pick one, then type comma to add more')
      .setRequired(false)
      .setAutocomplete(true)
    )
  )
  .addSubcommand(sub => sub
    .setName('accept')
    .setDescription('Accept a pending trade offer')
    .addStringOption(opt => opt
      .setName('id')
      .setDescription('Trade ID (from /trade list)')
      .setRequired(true)
      .setAutocomplete(true)
    )
  )
  .addSubcommand(sub => sub
    .setName('decline')
    .setDescription('Decline or cancel a pending trade')
    .addStringOption(opt => opt
      .setName('id')
      .setDescription('Trade ID (from /trade list)')
      .setRequired(true)
      .setAutocomplete(true)
    )
  )
  .addSubcommand(sub => sub
    .setName('list')
    .setDescription('View your pending trades and future picks')
  )
  .addSubcommand(sub => sub
    .setName('force')
    .setDescription('Force-execute a trade immediately (admin only)')
    .addStringOption(opt => opt
      .setName('offer-team')
      .setDescription('Team giving assets')
      .setRequired(true)
      .setAutocomplete(true)
    )
    .addStringOption(opt => opt
      .setName('receive-team')
      .setDescription('Team receiving assets')
      .setRequired(true)
      .setAutocomplete(true)
    )
    .addStringOption(opt => opt
      .setName('offer')
      .setDescription('Picks offer-team gives up — overall # or round.pick, comma-separated')
      .setRequired(false)
      .setAutocomplete(true)
    )
    .addStringOption(opt => opt
      .setName('receive')
      .setDescription('Picks receive-team gives up — overall # or round.pick, comma-separated')
      .setRequired(false)
      .setAutocomplete(true)
    )
    .addStringOption(opt => opt
      .setName('offer-players')
      .setDescription('Players offer-team gives up — name or jersey #, comma-separated')
      .setRequired(false)
      .setAutocomplete(true)
    )
    .addStringOption(opt => opt
      .setName('receive-players')
      .setDescription('Players receive-team gives up — name or jersey #, comma-separated')
      .setRequired(false)
      .setAutocomplete(true)
    )
    .addStringOption(opt => opt
      .setName('offer-future')
      .setDescription('Future picks offer-team gives — comma-separated (e.g. 2027R1)')
      .setRequired(false)
      .setAutocomplete(true)
    )
    .addStringOption(opt => opt
      .setName('receive-future')
      .setDescription('Future picks receive-team gives — comma-separated (e.g. 2027R1)')
      .setRequired(false)
      .setAutocomplete(true)
    )
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  manager: DraftManager
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'propose') {
    const toUser = interaction.options.getUser('to', true);
    const offerStr = interaction.options.getString('offer') ?? '';
    const receiveStr = interaction.options.getString('receive') ?? '';
    const offerPlayersStr = interaction.options.getString('offer-players') ?? '';
    const receivePlayersStr = interaction.options.getString('receive-players') ?? '';
    const offerFutureStr = interaction.options.getString('offer-future') ?? '';
    const receiveFutureStr = interaction.options.getString('receive-future') ?? '';

    // Accepts overall # (e.g. 5) or round.pick notation (e.g. 1.5)
    const parseOveralls = (s: string): number[] | null => {
      if (!s.trim()) return [];
      const parts = s.split(/[\s,]+/).filter(Boolean);
      const nums: number[] = [];
      for (const part of parts) {
        const rpMatch = part.match(/^(\d+)\.(\d+)$/);
        if (rpMatch) {
          const overall = manager.resolvePickByRoundPick(parseInt(rpMatch[1], 10), parseInt(rpMatch[2], 10));
          if (overall === null) return null;
          nums.push(overall);
        } else {
          const n = parseInt(part, 10);
          if (isNaN(n) || n <= 0) return null;
          nums.push(n);
        }
      }
      return nums;
    };

    // Accepts player name or jersey number (resolves to name)
    const parsePlayers = (s: string, teamAbbr: string): string[] | string => {
      if (!s.trim()) return [];
      const result: string[] = [];
      for (const entry of s.split(',').map(p => p.trim()).filter(Boolean)) {
        if (/^\d{1,3}$/.test(entry)) {
          const name = manager.resolvePlayerByJersey(teamAbbr, entry);
          if (!name) return `No player with jersey #${entry} on that team`;
          result.push(name);
        } else {
          result.push(entry);
        }
      }
      return result;
    };

    // Parse "2027R1,2028R3" → FuturePickRight ids for a given team
    const parseFuturePicks = (s: string, teamAbbr: string): string[] | string => {
      if (!s.trim()) return [];
      const entries = s.split(',').map(e => e.trim()).filter(Boolean);
      const ids: string[] = [];
      for (const entry of entries) {
        const m = entry.match(/^(\d{4})[Rr](\d)$/);
        if (!m) return `Invalid future pick format "${entry}". Use e.g. 2027R1,2028R3`;
        const year = parseInt(m[1], 10);
        const round = parseInt(m[2], 10);
        if (year < 2027 || year > 2029) return `Year must be 2027–2029 (got ${year})`;
        if (round < 1 || round > 7) return `Round must be 1–7 (got ${round})`;
        const right = manager.resolveFuturePickRight(teamAbbr, year, round);
        if (!right) return `No ${year} Round ${round} pick found for your team.`;
        ids.push(right.id);
      }
      return ids;
    };

    const offered = parseOveralls(offerStr);
    const requested = parseOveralls(receiveStr);

    if (offered === null) {
      await interaction.reply({ content: '❌ Invalid "offer" value. Use comma-separated overall pick numbers (e.g. `5,37`).', ephemeral: true });
      return;
    }
    if (requested === null) {
      await interaction.reply({ content: '❌ Invalid "receive" value. Use comma-separated overall pick numbers (e.g. `33,65`).', ephemeral: true });
      return;
    }

    // Teams must be resolved before parsing players (jersey # lookup) and future picks
    const proposerTeamAbbr = manager.getUserTeam(interaction.user.id);
    const receiverTeamAbbr = manager.getUserTeam(toUser.id);
    if (!proposerTeamAbbr) {
      await interaction.reply({ content: '❌ You do not have a registered team.', ephemeral: true });
      return;
    }
    if (!receiverTeamAbbr) {
      await interaction.reply({ content: '❌ That user does not have a registered team.', ephemeral: true });
      return;
    }

    const offeredPlayers = parsePlayers(offerPlayersStr, proposerTeamAbbr);
    if (typeof offeredPlayers === 'string') {
      await interaction.reply({ content: `❌ ${offeredPlayers}`, ephemeral: true });
      return;
    }
    const requestedPlayers = parsePlayers(receivePlayersStr, receiverTeamAbbr);
    if (typeof requestedPlayers === 'string') {
      await interaction.reply({ content: `❌ ${requestedPlayers}`, ephemeral: true });
      return;
    }

    const offeredFuture = parseFuturePicks(offerFutureStr, proposerTeamAbbr);
    if (typeof offeredFuture === 'string') {
      await interaction.reply({ content: `❌ ${offeredFuture}`, ephemeral: true });
      return;
    }
    const requestedFuture = parseFuturePicks(receiveFutureStr, receiverTeamAbbr);
    if (typeof requestedFuture === 'string') {
      await interaction.reply({ content: `❌ ${requestedFuture}`, ephemeral: true });
      return;
    }

    if (offered.length + offeredPlayers.length + offeredFuture.length === 0 ||
        requested.length + requestedPlayers.length + requestedFuture.length === 0) {
      await interaction.reply({ content: '❌ Must include at least one pick or player on each side.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const result = await manager.proposeTrade(
      interaction.user.id, toUser.id,
      offered, requested,
      offeredPlayers, requestedPlayers,
      offeredFuture, requestedFuture
    );

    if (!result.success) {
      await interaction.editReply(`❌ ${result.error}`);
      return;
    }

    const trade = result.trade!;
    const proposerTeamName = TEAMS[trade.proposerTeam]?.name ?? trade.proposerTeam;
    const receiverTeamName = TEAMS[trade.receiverTeam]?.name ?? trade.receiverTeam;

    const formatSide = (picks: number[], players: string[], futurePicks: string[]): string => {
      const parts: string[] = [];
      if (picks.length) parts.push(`picks **#${picks.join(', #')}**`);
      if (players.length) parts.push(`players **${players.join(', ')}**`);
      if (futurePicks.length) parts.push(`future picks **${futurePicks.map(id => {
        const m = id.match(/^(\d+)-R(\d+)-/);
        return m ? `${m[1]} R${m[2]}` : id;
      }).join(', ')}**`);
      return parts.join(' + ') || '_nothing_';
    };

    await interaction.editReply(
      `✅ Trade proposal **[${trade.id}]** sent!\n` +
      `**${proposerTeamName}** send: ${formatSide(offered, offeredPlayers, offeredFuture)}\n` +
      `**${receiverTeamName}** send: ${formatSide(requested, requestedPlayers, requestedFuture)}\n\n` +
      `${toUser} — use \`/trade accept ${trade.id}\` to accept, or \`/trade decline ${trade.id}\` to decline.`
    );
    return;
  }

  if (sub === 'accept') {
    const tradeId = interaction.options.getString('id', true).toUpperCase();
    await interaction.deferReply({ ephemeral: true });
    const result = await manager.acceptTrade(interaction.user.id, tradeId);

    if (!result.success) {
      await interaction.editReply(`❌ ${result.error}`);
      return;
    }
    await interaction.editReply(`✅ Trade **[${tradeId}]** accepted! Picks and players have been swapped.`);
    return;
  }

  if (sub === 'decline') {
    const tradeId = interaction.options.getString('id', true).toUpperCase();
    const result = await manager.declineTrade(interaction.user.id, tradeId);

    if (!result.success) {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: `✅ Trade **[${tradeId}]** cancelled.`, ephemeral: true });
    return;
  }

  if (sub === 'list') {
    const userTeam = manager.getUserTeam(interaction.user.id);
    if (!userTeam) {
      await interaction.reply({ content: '❌ You do not have a registered team.', ephemeral: true });
      return;
    }

    const trades = manager.getPendingTradesForUser(interaction.user.id);
    const futurePicks = manager.getFuturePicksForTeam(userTeam);
    const futurePickRights = manager.getFuturePickRightsForTeam(userTeam);
    const state = manager.getState();

    const embed = buildPendingTradesEmbed(trades, TEAMS, state.schedule, futurePicks, futurePickRights, userTeam);
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (sub === 'force') {
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: '❌ You need Administrator permission to use this command.', ephemeral: true });
      return;
    }

    const offerTeamAbbr = interaction.options.getString('offer-team', true).toUpperCase();
    const receiveTeamAbbr = interaction.options.getString('receive-team', true).toUpperCase();
    const offerStr = interaction.options.getString('offer') ?? '';
    const receiveStr = interaction.options.getString('receive') ?? '';
    const offerPlayersStr = interaction.options.getString('offer-players') ?? '';
    const receivePlayersStr = interaction.options.getString('receive-players') ?? '';
    const offerFutureStr = interaction.options.getString('offer-future') ?? '';
    const receiveFutureStr = interaction.options.getString('receive-future') ?? '';

    const parseOveralls = (s: string): number[] | null => {
      if (!s.trim()) return [];
      const parts = s.split(/[\s,]+/).filter(Boolean);
      const nums: number[] = [];
      for (const part of parts) {
        const rpMatch = part.match(/^(\d+)\.(\d+)$/);
        if (rpMatch) {
          const overall = manager.resolvePickByRoundPick(parseInt(rpMatch[1], 10), parseInt(rpMatch[2], 10));
          if (overall === null) return null;
          nums.push(overall);
        } else {
          const n = parseInt(part, 10);
          if (isNaN(n) || n <= 0) return null;
          nums.push(n);
        }
      }
      return nums;
    };

    const parsePlayers = (s: string, teamAbbr: string): string[] | string => {
      if (!s.trim()) return [];
      const result: string[] = [];
      for (const entry of s.split(',').map(p => p.trim()).filter(Boolean)) {
        if (/^\d{1,3}$/.test(entry)) {
          const name = manager.resolvePlayerByJersey(teamAbbr, entry);
          if (!name) return `No player with jersey #${entry} on that team`;
          result.push(name);
        } else {
          result.push(entry);
        }
      }
      return result;
    };

    const parseFuturePicks = (s: string, teamAbbr: string): string[] | string => {
      if (!s.trim()) return [];
      const entries = s.split(',').map(e => e.trim()).filter(Boolean);
      const ids: string[] = [];
      for (const entry of entries) {
        const m = entry.match(/^(\d{4})[Rr](\d)$/);
        if (!m) return `Invalid future pick format "${entry}". Use e.g. 2027R1,2028R3`;
        const year = parseInt(m[1], 10);
        const round = parseInt(m[2], 10);
        if (year < 2027 || year > 2029) return `Year must be 2027–2029 (got ${year})`;
        if (round < 1 || round > 7) return `Round must be 1–7 (got ${round})`;
        const right = manager.resolveFuturePickRight(teamAbbr, year, round);
        if (!right) return `No ${year} Round ${round} pick found for that team.`;
        ids.push(right.id);
      }
      return ids;
    };

    if (!TEAMS[offerTeamAbbr]) {
      await interaction.reply({ content: `❌ Unknown team: ${offerTeamAbbr}`, ephemeral: true });
      return;
    }
    if (!TEAMS[receiveTeamAbbr]) {
      await interaction.reply({ content: `❌ Unknown team: ${receiveTeamAbbr}`, ephemeral: true });
      return;
    }
    if (offerTeamAbbr === receiveTeamAbbr) {
      await interaction.reply({ content: '❌ Offer team and receive team must be different.', ephemeral: true });
      return;
    }

    const offered = parseOveralls(offerStr);
    const requested = parseOveralls(receiveStr);
    if (offered === null) {
      await interaction.reply({ content: '❌ Invalid "offer" value.', ephemeral: true }); return;
    }
    if (requested === null) {
      await interaction.reply({ content: '❌ Invalid "receive" value.', ephemeral: true }); return;
    }

    const offeredPlayers = parsePlayers(offerPlayersStr, offerTeamAbbr);
    if (typeof offeredPlayers === 'string') {
      await interaction.reply({ content: `❌ ${offeredPlayers}`, ephemeral: true }); return;
    }
    const requestedPlayers = parsePlayers(receivePlayersStr, receiveTeamAbbr);
    if (typeof requestedPlayers === 'string') {
      await interaction.reply({ content: `❌ ${requestedPlayers}`, ephemeral: true }); return;
    }

    const offeredFuture = parseFuturePicks(offerFutureStr, offerTeamAbbr);
    if (typeof offeredFuture === 'string') {
      await interaction.reply({ content: `❌ ${offeredFuture}`, ephemeral: true }); return;
    }
    const requestedFuture = parseFuturePicks(receiveFutureStr, receiveTeamAbbr);
    if (typeof requestedFuture === 'string') {
      await interaction.reply({ content: `❌ ${requestedFuture}`, ephemeral: true }); return;
    }

    if (offered.length + offeredPlayers.length + offeredFuture.length === 0 ||
        requested.length + requestedPlayers.length + requestedFuture.length === 0) {
      await interaction.reply({ content: '❌ Must include at least one pick or player on each side.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const result = await manager.adminForceTrade(
      offerTeamAbbr, receiveTeamAbbr,
      offered, requested,
      offeredPlayers, requestedPlayers,
      offeredFuture, requestedFuture
    );

    if (!result.success) {
      await interaction.editReply(`❌ ${result.error}`);
      return;
    }
    await interaction.editReply(`✅ Trade force-executed between **${TEAMS[offerTeamAbbr]?.name ?? offerTeamAbbr}** and **${TEAMS[receiveTeamAbbr]?.name ?? receiveTeamAbbr}**.`);
    return;
  }
}

export async function autocomplete(
  interaction: AutocompleteInteraction,
  manager: DraftManager
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const focusedOption = interaction.options.getFocused(true);
  const focusedName = focusedOption.name;
  const focusedValue = focusedOption.value as string;

  // ── accept / decline ──────────────────────────────────────────────────────
  if (sub === 'accept' || sub === 'decline') {
    const trades = manager.getPendingTradesForUser(interaction.user.id);
    const q = focusedValue.toUpperCase();

    if (sub === 'accept') {
      const choices = trades
        .filter(t => t.receiverUserId === interaction.user.id && t.id.includes(q))
        .slice(0, 25)
        .map(t => {
          const from = TEAMS[t.proposerTeam]?.name ?? t.proposerTeam;
          const give = t.offeredOveralls.map(o => `#${o}`).join(', ');
          const get = t.requestedOveralls.map(o => `#${o}`).join(', ');
          return { name: `[${t.id}] ${from}: get ${get}, give ${give}`, value: t.id };
        });
      await interaction.respond(choices);
    } else {
      const choices = trades
        .filter(t => t.id.includes(q))
        .slice(0, 25)
        .map(t => {
          const isProposer = t.proposerUserId === interaction.user.id;
          const counterparty = TEAMS[isProposer ? t.receiverTeam : t.proposerTeam]?.name ?? '';
          const role = isProposer ? 'Sent' : 'Received';
          return { name: `[${t.id}] ${role} → ${counterparty}`, value: t.id };
        });
      await interaction.respond(choices);
    }
    return;
  }

  // ── propose ───────────────────────────────────────────────────────────────
  if (sub === 'propose') {
    const proposerTeam = manager.getUserTeam(interaction.user.id);
    const toUserId = interaction.options.get('to')?.value as string | undefined;
    const receiverTeam = toUserId ? manager.getUserTeam(toUserId) : null;

    // Current-draft pick autocomplete (append-mode: existing,new)
    if (focusedName === 'offer' || focusedName === 'receive') {
      const teamAbbr = focusedName === 'offer' ? proposerTeam : receiverTeam;
      if (!teamAbbr) { await interaction.respond([]); return; }

      const picks = manager.getFuturePicksForTeam(teamAbbr);

      // Parse already-confirmed picks from the typed value
      const parts = focusedValue.split(',');
      const currentFragment = parts[parts.length - 1].trim();
      const prefix = parts.slice(0, -1).map(p => p.trim()).filter(Boolean);
      const alreadyPicked = new Set(prefix.map(Number));

      const choices = picks
        .filter(p => !alreadyPicked.has(p.overall) && String(p.overall).startsWith(currentFragment))
        .slice(0, 25)
        .map(p => {
          const teamName = TEAMS[p.currentTeam]?.name ?? p.currentTeam;
          const via = p.isTraded ? ` via ${TEAMS[p.originalTeam]?.name ?? p.originalTeam}` : '';
          const displayValue = prefix.length > 0
            ? `${prefix.join(',')},${p.overall}`
            : String(p.overall);
          const pickLabel = `#${p.overall} · R${p.round}P${p.roundPick} · ${teamName}${via}`;
          const name = prefix.length > 0
            ? `[#${prefix.join(', #')}, #${p.overall}] ${pickLabel}`
            : pickLabel;
          return { name: name.slice(0, 100), value: displayValue };
        });
      await interaction.respond(choices);
      return;
    }

    // Player autocomplete (append-mode: existing,new)
    if (focusedName === 'offer-players' || focusedName === 'receive-players') {
      const teamAbbr = focusedName === 'offer-players' ? proposerTeam : receiverTeam;
      if (!teamAbbr) { await interaction.respond([]); return; }

      const parts = focusedValue.split(',');
      const currentFragment = parts[parts.length - 1].trim();
      const prefix = parts.slice(0, -1).map(p => p.trim()).filter(Boolean);
      const alreadyPicked = new Set(prefix.map(n => n.toLowerCase()));

      const players = manager.searchRosterPlayers(teamAbbr, currentFragment);
      const choices = players
        .filter(p => !alreadyPicked.has(p.name.toLowerCase()))
        .slice(0, 25)
        .map(p => {
          const displayValue = prefix.length > 0
            ? `${prefix.join(',')},${p.name}`
            : p.name;
          const name = prefix.length > 0
            ? `[${prefix.join(', ')}, ${p.name}] (${p.pos})`
            : `${p.name} (${p.pos})`;
          return { name: name.slice(0, 100), value: displayValue };
        });
      await interaction.respond(choices);
      return;
    }

    // Future pick autocomplete (append-mode: existing,new)
    if (focusedName === 'offer-future' || focusedName === 'receive-future') {
      const teamAbbr = focusedName === 'offer-future' ? proposerTeam : receiverTeam;
      if (!teamAbbr) { await interaction.respond([]); return; }

      const rights = manager.getFuturePickRightsForTeam(teamAbbr);

      const parts = focusedValue.replace(/\s/g, '').split(',');
      const currentFragment = parts[parts.length - 1].toUpperCase();
      const prefix = parts.slice(0, -1).map(p => p.trim().toUpperCase()).filter(Boolean);
      const alreadyPicked = new Set(prefix);

      const choices = rights
        .filter(r => {
          const key = `${r.year}R${r.round}`;
          return !alreadyPicked.has(key) && key.includes(currentFragment);
        })
        .sort((a, b) => a.year - b.year || a.round - b.round)
        .slice(0, 25)
        .map(r => {
          const key = `${r.year}R${r.round}`;
          const via = r.originalTeam !== teamAbbr
            ? ` (via ${TEAMS[r.originalTeam]?.name ?? r.originalTeam})`
            : '';
          const displayValue = prefix.length > 0 ? `${prefix.join(',')},${key}` : key;
          const pickLabel = `${r.year} Round ${r.round}${via}`;
          const name = prefix.length > 0
            ? `[${prefix.join(', ')}, ${key}] ${pickLabel}`
            : pickLabel;
          return { name: name.slice(0, 100), value: displayValue };
        });
      await interaction.respond(choices);
      return;
    }
  }

  // ── force (admin) ─────────────────────────────────────────────────────────
  if (sub === 'force') {
    const state = manager.getState();

    // Team autocomplete for offer-team / receive-team
    if (focusedName === 'offer-team' || focusedName === 'receive-team') {
      const q = focusedValue.toUpperCase();
      const choices = Object.keys(TEAMS)
        .filter(abbr => abbr.includes(q) || TEAMS[abbr].name.toUpperCase().includes(q))
        .slice(0, 25)
        .map(abbr => {
          const gmId = state.assignments[abbr];
          const label = gmId ? '' : ' (no GM)';
          return { name: `${TEAMS[abbr].name} (${abbr})${label}`, value: abbr };
        });
      await interaction.respond(choices);
      return;
    }

    const offerTeamAbbr = (interaction.options.get('offer-team')?.value as string | undefined)?.toUpperCase() ?? null;
    const receiveTeamAbbr = (interaction.options.get('receive-team')?.value as string | undefined)?.toUpperCase() ?? null;

    // Current-draft pick autocomplete
    if (focusedName === 'offer' || focusedName === 'receive') {
      const teamAbbr = focusedName === 'offer' ? offerTeamAbbr : receiveTeamAbbr;
      if (!teamAbbr) { await interaction.respond([]); return; }

      const picks = manager.getFuturePicksForTeam(teamAbbr);
      const parts = focusedValue.split(',');
      const currentFragment = parts[parts.length - 1].trim();
      const prefix = parts.slice(0, -1).map(p => p.trim()).filter(Boolean);
      const alreadyPicked = new Set(prefix.map(Number));

      const choices = picks
        .filter(p => !alreadyPicked.has(p.overall) && String(p.overall).startsWith(currentFragment))
        .slice(0, 25)
        .map(p => {
          const teamName = TEAMS[p.currentTeam]?.name ?? p.currentTeam;
          const via = p.isTraded ? ` via ${TEAMS[p.originalTeam]?.name ?? p.originalTeam}` : '';
          const displayValue = prefix.length > 0 ? `${prefix.join(',')},${p.overall}` : String(p.overall);
          const pickLabel = `#${p.overall} · R${p.round}P${p.roundPick} · ${teamName}${via}`;
          const name = prefix.length > 0 ? `[#${prefix.join(', #')}, #${p.overall}] ${pickLabel}` : pickLabel;
          return { name: name.slice(0, 100), value: displayValue };
        });
      await interaction.respond(choices);
      return;
    }

    // Player autocomplete
    if (focusedName === 'offer-players' || focusedName === 'receive-players') {
      const teamAbbr = focusedName === 'offer-players' ? offerTeamAbbr : receiveTeamAbbr;
      if (!teamAbbr) { await interaction.respond([]); return; }

      const parts = focusedValue.split(',');
      const currentFragment = parts[parts.length - 1].trim();
      const prefix = parts.slice(0, -1).map(p => p.trim()).filter(Boolean);
      const alreadyPicked = new Set(prefix.map(n => n.toLowerCase()));

      const players = manager.searchRosterPlayers(teamAbbr, currentFragment);
      const choices = players
        .filter(p => !alreadyPicked.has(p.name.toLowerCase()))
        .slice(0, 25)
        .map(p => {
          const displayValue = prefix.length > 0 ? `${prefix.join(',')},${p.name}` : p.name;
          const name = prefix.length > 0 ? `[${prefix.join(', ')}, ${p.name}] (${p.pos})` : `${p.name} (${p.pos})`;
          return { name: name.slice(0, 100), value: displayValue };
        });
      await interaction.respond(choices);
      return;
    }

    // Future pick autocomplete
    if (focusedName === 'offer-future' || focusedName === 'receive-future') {
      const teamAbbr = focusedName === 'offer-future' ? offerTeamAbbr : receiveTeamAbbr;
      if (!teamAbbr) { await interaction.respond([]); return; }

      const rights = manager.getFuturePickRightsForTeam(teamAbbr);
      const parts = focusedValue.replace(/\s/g, '').split(',');
      const currentFragment = parts[parts.length - 1].toUpperCase();
      const prefix = parts.slice(0, -1).map(p => p.trim().toUpperCase()).filter(Boolean);
      const alreadyPicked = new Set(prefix);

      const choices = rights
        .filter(r => {
          const key = `${r.year}R${r.round}`;
          return !alreadyPicked.has(key) && key.includes(currentFragment);
        })
        .sort((a, b) => a.year - b.year || a.round - b.round)
        .slice(0, 25)
        .map(r => {
          const key = `${r.year}R${r.round}`;
          const via = r.originalTeam !== teamAbbr ? ` (via ${TEAMS[r.originalTeam]?.name ?? r.originalTeam})` : '';
          const displayValue = prefix.length > 0 ? `${prefix.join(',')},${key}` : key;
          const pickLabel = `${r.year} Round ${r.round}${via}`;
          const name = prefix.length > 0 ? `[${prefix.join(', ')}, ${key}] ${pickLabel}` : pickLabel;
          return { name: name.slice(0, 100), value: displayValue };
        });
      await interaction.respond(choices);
      return;
    }
  }

  await interaction.respond([]);
}
