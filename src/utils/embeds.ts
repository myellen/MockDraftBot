import { EmbedBuilder } from 'discord.js';
import { CompletedPick, PickSlot, PendingTrade, FuturePickRight } from '../draft/types';
import { Team } from '../draft/types';

const DEFAULT_COLOR = 0xFFB612;

function pickLabel(round: number, pick: number): string {
  return `${round}.${String(pick).padStart(2, '0')}`;
}

export function buildPickEmbed(pick: CompletedPick, slot: PickSlot, team: Team): EmbedBuilder {
  const label = pickLabel(pick.round, pick.roundPick);
  const embed = new EmbedBuilder()
    .setColor(team?.color ?? DEFAULT_COLOR)
    .setTitle(`🏈 Pick ${label} — ${team?.name ?? pick.team}`)
    .setDescription(`**${pick.prospectName}**`)
    .addFields(
      { name: 'Position', value: pick.pos, inline: true },
      { name: 'School',   value: pick.school, inline: true },
      { name: 'Overall',  value: `#${pick.overall}`, inline: true },
    );

  const footerParts: string[] = [];
  if (slot.isTraded) footerParts.push(`Via ${slot.originalTeam}`);
  if (pick.autoPicked) footerParts.push('Auto-picked');
  if (footerParts.length) embed.setFooter({ text: footerParts.join(' · ') });

  return embed;
}

export function buildOnTheClockEmbed(
  slot: PickSlot,
  team: Team,
  userId: string | null,
  timerSeconds: number | null
): EmbedBuilder {
  const label = pickLabel(slot.round, slot.roundPick);
  const userMention = userId ? `<@${userId}>` : '🤖 CPU';
  const embed = new EmbedBuilder()
    .setColor(team?.color ?? DEFAULT_COLOR)
    .setTitle(`⏱️ On the Clock — Pick ${label}`)
    .setDescription(`${userMention} — **${team?.name ?? slot.currentTeam}** are on the clock!`)
    .addFields({ name: 'Overall Pick', value: `#${slot.overall}`, inline: true });

  if (timerSeconds && userId) {
    embed.addFields({ name: 'Time Limit', value: `${timerSeconds}s`, inline: true });
  }
  if (slot.isTraded) {
    embed.setFooter({ text: `Via ${slot.originalTeam}` });
  }
  if (userId) {
    embed.addFields({ name: 'How to pick', value: '`/pick <player name>`', inline: false });
  }
  return embed;
}

export function buildDraftCompleteEmbed(picks: CompletedPick[], totalPicks: number): EmbedBuilder {
  const rounds = Math.max(...picks.map(p => p.round));
  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🏆 Mock Draft Complete!')
    .setDescription(`The 2026 NFL Mock Draft is in the books!\n\n**${picks.length} / ${totalPicks} picks made** across ${rounds} rounds.`)
    .addFields(
      { name: 'Use `/board` to browse all picks', value: '\u200B', inline: false }
    )
    .setTimestamp();
}

export function buildBoardEmbed(
  prospects: Array<{ rank: number; name: string; pos: string; school: string }>,
  page: number,
  totalPages: number,
  total: number,
  posFilter?: string
): EmbedBuilder {
  const title = posFilter ? `📋 Available ${posFilter}s` : '📋 Draft Board';
  const rows = prospects.map(p =>
    `\`#${String(p.rank).padStart(3, ' ')}\` **${p.name}** — ${p.pos}, ${p.school}`
  ).join('\n');

  return new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle(title)
    .setDescription(rows || 'No prospects match that filter.')
    .setFooter({ text: `Page ${page}/${totalPages} · ${total} available` });
}

function formatPickList(overalls: number[], schedule: PickSlot[], teams: Record<string, Team>): string {
  return overalls.map(o => {
    const slot = schedule.find(s => s.overall === o);
    if (!slot) return `#${o}`;
    return `R${slot.round}P${slot.roundPick} (#${o}) — ${teams[slot.currentTeam]?.name ?? slot.currentTeam}`;
  }).join('\n');
}

function formatFuturePickId(id: string): string {
  const m = id.match(/^(\d{4})-R(\d+)-(.+)$/);
  if (!m) return id;
  return `${m[1]} Round ${m[2]} (${m[3]})`;
}

function formatTradeSide(overalls: number[], players: string[], futurePicks: string[], schedule: PickSlot[], teams: Record<string, Team>): string {
  const parts: string[] = [];
  if (overalls.length) parts.push(formatPickList(overalls, schedule, teams));
  if (players.length) parts.push(players.map(p => `👤 ${p}`).join('\n'));
  if (futurePicks.length) parts.push(futurePicks.map(id => `📅 ${formatFuturePickId(id)}`).join('\n'));
  return parts.join('\n') || '_nothing_';
}

export function buildTradeExecutedEmbed(
  trade: PendingTrade,
  teams: Record<string, Team>,
  schedule: PickSlot[]
): EmbedBuilder {
  const proposer = teams[trade.proposerTeam]?.name ?? trade.proposerTeam;
  const receiver = teams[trade.receiverTeam]?.name ?? trade.receiverTeam;

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔄 Trade Executed!')
    .addFields(
      {
        name: `${proposer} receive`,
        value: formatTradeSide(trade.requestedOveralls, trade.requestedPlayers, trade.requestedFuturePicks, schedule, teams),
        inline: true,
      },
      {
        name: `${receiver} receive`,
        value: formatTradeSide(trade.offeredOveralls, trade.offeredPlayers, trade.offeredFuturePicks, schedule, teams),
        inline: true,
      },
    )
    .setTimestamp();
}

export function buildPendingTradesEmbed(
  trades: PendingTrade[],
  teams: Record<string, Team>,
  schedule: PickSlot[],
  futurePicks: PickSlot[],
  futurePickRights: FuturePickRight[],
  userTeam: string
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle('📋 Your Trades & Future Picks');

  if (trades.length === 0) {
    embed.addFields({ name: 'Pending Trades', value: '_None_', inline: false });
  } else {
    const lines = trades.map(t => {
      const isProposer = t.proposerTeam === userTeam;
      const counterparty = isProposer ? (teams[t.receiverTeam]?.name ?? t.receiverTeam) : (teams[t.proposerTeam]?.name ?? t.proposerTeam);
      const givingPicks = isProposer ? t.offeredOveralls : t.requestedOveralls;
      const gettingPicks = isProposer ? t.requestedOveralls : t.offeredOveralls;
      const givingPlayers = isProposer ? t.offeredPlayers : t.requestedPlayers;
      const gettingPlayers = isProposer ? t.requestedPlayers : t.offeredPlayers;
      const givingFuture = isProposer ? t.offeredFuturePicks : t.requestedFuturePicks;
      const gettingFuture = isProposer ? t.requestedFuturePicks : t.offeredFuturePicks;
      const role = isProposer ? 'Sent' : 'Received';
      const giveParts = [
        ...givingPicks.map(o => `#${o}`),
        ...givingPlayers,
        ...givingFuture.map(id => formatFuturePickId(id)),
      ];
      const getParts = [
        ...gettingPicks.map(o => `#${o}`),
        ...gettingPlayers,
        ...gettingFuture.map(id => formatFuturePickId(id)),
      ];
      return `**[${t.id}]** ${role} → ${counterparty}\n  Give: ${giveParts.join(', ')} · Get: ${getParts.join(', ')}`;
    });
    embed.addFields({ name: `Pending Trades (${trades.length})`, value: lines.join('\n'), inline: false });
  }

  // Current draft future picks
  const pickLines = futurePicks.map(s =>
    `R${s.round}P${s.roundPick} · Overall **#${s.overall}**${s.isTraded ? ` _(via ${s.originalTeam})_` : ''}`
  );
  embed.addFields({
    name: `2026 Draft Picks (${futurePicks.length})`,
    value: pickLines.length ? pickLines.join('\n') : '_None remaining_',
    inline: false,
  });

  // Future year pick rights grouped by year
  const byYear = new Map<number, FuturePickRight[]>();
  for (const r of futurePickRights.sort((a, b) => a.year - b.year || a.round - b.round)) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year)!.push(r);
  }
  for (const [year, rights] of byYear) {
    const lines = rights.map(r => {
      const via = r.originalTeam !== userTeam ? ` _(via ${r.originalTeam})_` : '';
      return `Round ${r.round}${via}`;
    });
    embed.addFields({
      name: `${year} Picks (${rights.length})`,
      value: lines.join(', '),
      inline: false,
    });
  }

  return embed;
}

export function buildTeamRosterEmbed(team: Team, abbr: string, picks: CompletedPick[]): EmbedBuilder {
  const rows = picks.length
    ? picks.map(p =>
        `**R${p.round}** #${p.overall}: **${p.prospectName}** (${p.pos}, ${p.school})${p.autoPicked ? ' ⚡' : ''}`
      ).join('\n')
    : '_No picks yet._';

  return new EmbedBuilder()
    .setColor(team?.color ?? DEFAULT_COLOR)
    .setTitle(`🏈 ${team.name}`)
    .setDescription(rows)
    .setFooter({ text: `${abbr} · ${picks.length} pick${picks.length !== 1 ? 's' : ''}` });
}

export function buildAssignmentsEmbed(
  assignments: Record<string, string>,
  teams: Record<string, Team>
): EmbedBuilder {
  const assigned: string[] = [];
  const unassigned: string[] = [];

  for (const [abbr, team] of Object.entries(teams)) {
    const userId = assignments[abbr];
    if (userId) {
      assigned.push(`${team.name} → <@${userId}>`);
    } else {
      unassigned.push(team.name);
    }
  }

  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle('🏈 Team Assignments')
    .addFields(
      {
        name: `✅ Assigned (${assigned.length}/32)`,
        value: assigned.length ? assigned.join('\n') : 'None yet',
        inline: false,
      },
      {
        name: `⬜ Available (${unassigned.length})`,
        value: unassigned.length ? unassigned.join(', ') : 'All teams claimed!',
        inline: false,
      }
    );
  return embed;
}

export function buildStatusEmbed(
  status: string,
  slot: PickSlot | null,
  currentTeam: Team | null,
  userId: string | null,
  timeRemaining: number | null,
  lastPicks: CompletedPick[],
  totalPicks: number,
  madeCount: number
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle('📊 Draft Status')
    .addFields({ name: 'Status', value: status.toUpperCase(), inline: true });

  if (slot && currentTeam) {
    const label = pickLabel(slot.round, slot.roundPick);
    embed.addFields(
      { name: 'Current Pick', value: `Pick ${label} (Overall #${slot.overall})`, inline: true },
      { name: 'On the Clock', value: currentTeam.name, inline: true },
    );
    if (userId) embed.addFields({ name: 'GM', value: `<@${userId}>`, inline: true });
    if (timeRemaining !== null) {
      embed.addFields({ name: '⏳ Time Remaining', value: `${timeRemaining}s`, inline: true });
    }
  }

  embed.addFields({ name: 'Progress', value: `${madeCount} / ${totalPicks} picks`, inline: true });

  if (lastPicks.length) {
    const recent = lastPicks.map(p =>
      `**${pickLabel(p.round, p.roundPick)}** ${p.team}: ${p.prospectName} (${p.pos})`
    ).join('\n');
    embed.addFields({ name: 'Recent Picks', value: recent, inline: false });
  }

  return embed;
}
