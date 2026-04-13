import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { DraftManager } from '../discord/DraftManager';
import { TEAMS } from '../data/teams';
import { TEAM_EMOJI } from '../utils/teamEmoji';
import { buildTradeChartUrl } from '../utils/embeds';
import { PendingTrade, PickSlot } from '../engine/types';

export const data = new SlashCommandBuilder()
  .setName('trade-history')
  .setDescription('View all completed trades in chronological order');

function formatSide(overalls: number[], players: string[], futurePicks: string[], slotMap: Map<number, PickSlot>): string {
  const parts: string[] = [];
  for (const o of overalls) {
    const s = slotMap.get(o);
    parts.push(s ? `R${s.round} #${o}` : `#${o}`);
  }
  for (const p of players) parts.push(p);
  for (const fp of futurePicks) {
    const [year, roundTag, team] = fp.split('-');
    const via = team ? ` (${team})` : '';
    parts.push(`${year} ${roundTag}${via}`);
  }
  return parts.join(', ') || '_nothing_';
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  manager: DraftManager
): Promise<void> {
  const history = manager.trades.getTradeHistory();
  if (history.length === 0) {
    await interaction.reply({ content: 'No trades have been completed yet.', ephemeral: true });
    return;
  }

  const schedule = manager.getState().schedule;
  const slotMap = new Map(schedule.map(s => [s.overall, s]));

  const lines = history.map((t, i) => {
    const e1 = TEAM_EMOJI[t.proposerTeam] ?? '';
    const e2 = TEAM_EMOJI[t.receiverTeam] ?? '';
    const name1 = TEAMS[t.proposerTeam]?.name ?? t.proposerTeam;
    const name2 = TEAMS[t.receiverTeam]?.name ?? t.receiverTeam;

    const gm1 = t.proposerUserId && t.proposerUserId !== 'admin' ? ` (${manager.resolveUserName(t.proposerUserId)})` : '';
    const gm2 = t.receiverUserId && t.receiverUserId !== 'admin' ? ` (${manager.resolveUserName(t.receiverUserId)})` : '';

    const team1Gets = formatSide(t.requestedOveralls, t.requestedPlayers, t.requestedFuturePicks, slotMap);
    const team2Gets = formatSide(t.offeredOveralls, t.offeredPlayers, t.offeredFuturePicks, slotMap);

    const hasPicks = t.offeredOveralls.length > 0 || t.requestedOveralls.length > 0 ||
      t.offeredFuturePicks.length > 0 || t.requestedFuturePicks.length > 0;
    const chartLink = hasPicks ? `  [Trade chart](${buildTradeChartUrl(t, schedule)})` : '';
    return `**${i + 1}.** ${e1} **${name1}**${gm1} receive: ${team1Gets}\n\u2003\u2003${e2} **${name2}**${gm2} receive: ${team2Gets}${chartLink}`;
  });

  const description = lines.join('\n\n');

  // Split across multiple embeds if needed (4096 char limit)
  const embeds: EmbedBuilder[] = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 2 > 4000) {
      embeds.push(new EmbedBuilder().setColor(0x5865F2).setDescription(current));
      current = '';
    }
    current += (current ? '\n\n' : '') + line;
  }
  if (current) {
    const embed = new EmbedBuilder().setColor(0x5865F2).setDescription(current);
    if (embeds.length === 0) embed.setTitle(`🔄 Trade History (${history.length} trade${history.length !== 1 ? 's' : ''})`);
    embeds.push(embed);
  }
  if (embeds.length > 0 && !embeds[0].data.title) {
    embeds[0].setTitle(`🔄 Trade History (${history.length} trade${history.length !== 1 ? 's' : ''})`);
  }

  // Build trade leaderboard
  const tradeCounts = new Map<string, { emoji: string; name: string; count: number }>();
  for (const t of history) {
    for (const abbr of [t.proposerTeam, t.receiverTeam]) {
      if (!tradeCounts.has(abbr)) {
        tradeCounts.set(abbr, { emoji: TEAM_EMOJI[abbr] ?? '', name: TEAMS[abbr]?.name ?? abbr, count: 0 });
      }
      tradeCounts.get(abbr)!.count++;
    }
  }
  const sorted = [...tradeCounts.values()].sort((a, b) => b.count - a.count);
  const medals = ['🥇', '🥈', '🥉'];
  let rank = 0;
  let medalIdx = 0;
  const leaderboardLines = sorted.map((entry, i) => {
    if (i === 0 || entry.count < sorted[i - 1].count) {
      rank = i + 1;
      medalIdx = i;
    }
    const prefix = medalIdx < 3 ? medals[medalIdx] : `**${rank}.**`;
    return `${prefix} ${entry.emoji} ${entry.name} — ${entry.count} trade${entry.count !== 1 ? 's' : ''}`;
  });

  const leaderboard = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📊 Trade Leaderboard')
    .setDescription(leaderboardLines.join('\n'));

  // Build hit rate leaderboard
  const cancelled = manager.trades.getCancelledTrades();
  const assignments = manager.getState().assignments;
  const hitRateData = new Map<string, { emoji: string; name: string; gm: string | null; accepted: number; total: number }>();
  const ensureTeam = (abbr: string) => {
    if (!hitRateData.has(abbr)) {
      hitRateData.set(abbr, {
        emoji: TEAM_EMOJI[abbr] ?? '',
        name: TEAMS[abbr]?.name ?? abbr,
        gm: assignments[abbr] ?? null,
        accepted: 0,
        total: 0,
      });
    }
  };
  for (const t of history) {
    ensureTeam(t.proposerTeam);
    hitRateData.get(t.proposerTeam)!.accepted++;
    hitRateData.get(t.proposerTeam)!.total++;
  }
  for (const t of cancelled) {
    ensureTeam(t.proposerTeam);
    hitRateData.get(t.proposerTeam)!.total++;
  }
  const hitRateSorted = [...hitRateData.values()]
    .filter(e => e.total > 0)
    .map(e => ({ ...e, rate: e.accepted / e.total }))
    .sort((a, b) => b.rate - a.rate || b.accepted - a.accepted);

  let hitRank = 0;
  let hitMedalIdx = 0;
  const hitRateLines = hitRateSorted.map((entry, i) => {
    if (i === 0 || entry.rate < hitRateSorted[i - 1].rate) {
      hitRank = i + 1;
      hitMedalIdx = i;
    }
    const prefix = hitMedalIdx < 3 ? medals[hitMedalIdx] : `**${hitRank}.**`;
    const pct = Math.round(entry.rate * 100);
    const gmTag = entry.gm ? ` (${manager.resolveUserName(entry.gm)})` : '';
    return `${prefix} ${entry.emoji} ${entry.name}${gmTag} — ${pct}% (${entry.accepted}/${entry.total})`;
  });

  const hitRateEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎯 Trade Hit Rate')
    .setDescription(hitRateLines.join('\n'));

  // Send trade history embeds, splitting across messages to stay under 6000 char limit
  let batch: EmbedBuilder[] = [];
  let batchSize = 0;
  let isFirst = true;

  for (const embed of embeds) {
    const embedSize = (embed.data.description?.length ?? 0) + (embed.data.title?.length ?? 0) + 100;
    if (batchSize + embedSize > 5800 && batch.length > 0) {
      if (isFirst) {
        await interaction.reply({ embeds: batch });
        isFirst = false;
      } else {
        await interaction.followUp({ embeds: batch });
      }
      batch = [];
      batchSize = 0;
    }
    batch.push(embed);
    batchSize += embedSize;
  }
  if (batch.length > 0) {
    if (isFirst) {
      await interaction.reply({ embeds: batch });
      isFirst = false;
    } else {
      await interaction.followUp({ embeds: batch });
    }
  }
  await interaction.followUp({ embeds: [leaderboard, hitRateEmbed] });
}
