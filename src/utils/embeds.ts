import { EmbedBuilder } from 'discord.js';
import { CompletedPick, PickSlot, PendingTrade, FuturePickRight } from '../draft/types';
import { Team } from '../draft/types';
import { ordinal } from './ordinal';

const DEFAULT_COLOR = 0xFFB612;

function pickLabel(round: number, pick: number): string {
  return `${round}.${String(pick).padStart(2, '0')}`;
}

export function buildPickEmbed(pick: CompletedPick, slot: PickSlot, team: Team): EmbedBuilder {
  const label = pickLabel(pick.round, pick.roundPick);
  const embed = new EmbedBuilder()
    .setColor(team?.color ?? DEFAULT_COLOR)
    .setTitle(`With the ${ordinal(pick.overall)} pick in the NFL draft, the ${team?.name ?? pick.team} select:`)
    .setDescription(`**${pick.prospectName}** (${pick.pos}, ${pick.school})\nRound ${pick.round}, Pick ${pick.roundPick} · Overall #${pick.overall}`);

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

export function buildMyBoardEmbed(
  teamName: string,
  entries: { boardPos: number; rank: number; name: string; pos: string; school: string; available: boolean }[],
  page: number,
  totalPages: number,
  total: number,
  positionPriority: string[]
): EmbedBuilder {
  const rows = entries.map(e => {
    const line = `**${e.boardPos}.** \`#${String(e.rank).padStart(3, ' ')}\` ${e.name} — ${e.pos}, ${e.school}`;
    return e.available ? line : `~~${line}~~`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setColor(DEFAULT_COLOR)
    .setTitle(`📋 ${teamName} — Custom Board`)
    .setDescription(rows || 'No players on your board yet. Use `/board submit` to upload one.');

  if (positionPriority.length > 0) {
    embed.addFields({ name: 'Position Priority', value: positionPriority.join(' → '), inline: false });
  }

  embed.setFooter({ text: `Page ${page}/${totalPages} · ${total} players on board · ~~struck through~~ = already drafted` });
  return embed;
}

/**
 * Estimate the overall pick number for a future-year pick based on the team's
 * current-year draft position.
 */
function estimateFuturePickOverall(futurePickId: string, schedule: PickSlot[]): { year: number; overall: number } | null {
  const m = futurePickId.match(/^(\d{4})-R(\d+)-(.+)$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const round = parseInt(m[2], 10);
  const origTeam = m[3];

  // Find this team's original pick in the same round
  const slot = schedule.find(s => s.originalTeam === origTeam && s.round === round);
  if (slot) return { year, overall: slot.overall };

  // Fallback: offset from their round 1 position
  const r1Slot = schedule.find(s => s.originalTeam === origTeam && s.round === 1);
  if (r1Slot) return { year, overall: (round - 1) * 32 + r1Slot.roundPick };

  // Last resort: middle of the round
  return { year, overall: (round - 1) * 32 + 16 };
}

/**
 * Build a trade chart URL for a given trade.
 * Format: https://kvatsaas.github.io/trade-charts/?teama=X&teamb=Y&a=YEAR.OVERALL&b=YEAR.OVERALL
 */
export function buildTradeChartUrl(trade: PendingTrade, schedule: PickSlot[]): string {
  const params: string[] = [
    `teama=${trade.proposerTeam.toLowerCase()}`,
    `teamb=${trade.receiverTeam.toLowerCase()}`,
  ];

  // What proposer sends (a=)
  for (const overall of trade.offeredOveralls) {
    params.push(`a=2026.${overall}`);
  }
  for (const fpId of trade.offeredFuturePicks) {
    const est = estimateFuturePickOverall(fpId, schedule);
    if (est) params.push(`a=${est.year}.${est.overall}`);
  }

  // What receiver sends (b=)
  for (const overall of trade.requestedOveralls) {
    params.push(`b=2026.${overall}`);
  }
  for (const fpId of trade.requestedFuturePicks) {
    const est = estimateFuturePickOverall(fpId, schedule);
    if (est) params.push(`b=${est.year}.${est.overall}`);
  }

  return `https://kvatsaas.github.io/trade-charts/?${params.join('&')}`;
}

function formatPickList(overalls: number[], schedule: PickSlot[], teams: Record<string, Team>): string {
  return overalls.map(o => {
    const slot = schedule.find(s => s.overall === o);
    if (!slot) return `#${o}`;
    return `R${slot.round}P${slot.roundPick} (#${o})`;
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

  const hasPicks = trade.offeredOveralls.length > 0 || trade.requestedOveralls.length > 0 ||
    trade.offeredFuturePicks.length > 0 || trade.requestedFuturePicks.length > 0;
  const chartLink = hasPicks ? `\n[Trade chart](${buildTradeChartUrl(trade, schedule)})` : '';

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
    .setDescription(chartLink || null)
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
      const hasPicks = givingPicks.length > 0 || gettingPicks.length > 0 || givingFuture.length > 0 || gettingFuture.length > 0;
      const chartLink = hasPicks ? `  [Trade chart](${buildTradeChartUrl(t, schedule)})` : '';
      return `**[${t.id}]** ${role} → ${counterparty}\n  Give: ${giveParts.join(', ')} · Get: ${getParts.join(', ')}${chartLink}`;
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

export function buildTeamRosterEmbed(team: Team, abbr: string, picks: CompletedPick[], trades?: PendingTrade[], schedule?: PickSlot[]): EmbedBuilder {
  const rows = picks.length
    ? picks.map(p =>
        `**R${p.round}** #${p.overall}: **${p.prospectName}** (${p.pos}, ${p.school})${p.autoPicked ? ' ⚡' : ''}`
      ).join('\n')
    : '_No picks yet._';

  let description = rows;

  if (trades?.length) {
    const teamTrades = trades.filter(t => t.proposerTeam === abbr || t.receiverTeam === abbr);
    if (teamTrades.length > 0) {
      const slotMap = new Map(schedule?.map(s => [s.overall, s]) ?? []);
      const tradeLines = teamTrades.map(t => {
        const isProposer = t.proposerTeam === abbr;
        const otherTeam = isProposer ? t.receiverTeam : t.proposerTeam;
        const sent = isProposer ? t.offeredOveralls : t.requestedOveralls;
        const received = isProposer ? t.requestedOveralls : t.offeredOveralls;
        const sentPlayers = isProposer ? t.offeredPlayers : t.requestedPlayers;
        const receivedPlayers = isProposer ? t.requestedPlayers : t.offeredPlayers;
        const sentFuture = isProposer ? t.offeredFuturePicks : t.requestedFuturePicks;
        const receivedFuture = isProposer ? t.requestedFuturePicks : t.offeredFuturePicks;

        const fmtPick = (o: number) => { const s = slotMap.get(o); return s ? `R${s.round} #${o}` : `#${o}`; };
        const parts: string[] = [];
        if (sent.length) parts.push(`Sent ${sent.map(fmtPick).join(', ')}`);
        if (sentPlayers.length) parts.push(`Sent ${sentPlayers.join(', ')}`);
        if (sentFuture.length) parts.push(`Sent ${sentFuture.length} future pick${sentFuture.length !== 1 ? 's' : ''}`);
        if (received.length) parts.push(`Got ${received.map(fmtPick).join(', ')}`);
        if (receivedPlayers.length) parts.push(`Got ${receivedPlayers.join(', ')}`);
        if (receivedFuture.length) parts.push(`Got ${receivedFuture.length} future pick${receivedFuture.length !== 1 ? 's' : ''}`);
        return `↔ **${otherTeam}**: ${parts.join(' · ')}`;
      });
      description += `\n\n**Trades:**\n${tradeLines.join('\n')}`;
    }
  }

  return new EmbedBuilder()
    .setColor(team?.color ?? DEFAULT_COLOR)
    .setTitle(`🏈 ${team.name}`)
    .setDescription(description.slice(0, 4096))
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
    .setTitle('🏈 Team Assignments');

  // Split assigned list into chunks to stay under Discord's 1024-char field limit
  if (!assigned.length) {
    embed.addFields({ name: `✅ Assigned (0/32)`, value: 'None yet', inline: false });
  } else {
    const chunks: string[][] = [[]];
    for (const line of assigned) {
      const current = chunks[chunks.length - 1];
      if (current.join('\n').length + line.length + 1 > 1024) {
        chunks.push([line]);
      } else {
        current.push(line);
      }
    }
    chunks.forEach((chunk, i) => {
      const name = i === 0 ? `✅ Assigned (${assigned.length}/32)` : '\u200b';
      embed.addFields({ name, value: chunk.join('\n'), inline: false });
    });
  }

  embed.addFields({
    name: `⬜ Available (${unassigned.length})`,
    value: unassigned.length ? unassigned.join(', ') : 'All teams claimed!',
    inline: false,
  });

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
