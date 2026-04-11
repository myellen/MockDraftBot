import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
} from 'discord.js';
import { DraftManager, formatCapAmount } from '../draft/DraftManager';
import { TEAMS } from '../data/teams';
import { TEAM_CAP } from '../data/capData';

const POS_GROUPS: Array<{ label: string; positions: string[] }> = [
  { label: 'QB',    positions: ['QB'] },
  { label: 'RB',    positions: ['RB', 'FB', 'HB'] },
  { label: 'WR',    positions: ['WR'] },
  { label: 'TE',    positions: ['TE'] },
  { label: 'OL',    positions: ['OT', 'OG', 'C', 'OL', 'G', 'T'] },
  { label: 'DL',    positions: ['DE', 'DT', 'NT', 'DL'] },
  { label: 'LB',    positions: ['LB', 'OLB', 'ILB', 'MLB'] },
  { label: 'DB',    positions: ['CB', 'S', 'FS', 'SS', 'DB'] },
  { label: 'ST',    positions: ['K', 'P', 'LS', 'KR', 'PR'] },
];

export const data = new SlashCommandBuilder()
  .setName('inventory')
  .setDescription("View a team's draft picks and roster")
  .addStringOption(opt => opt
    .setName('team')
    .setDescription('Team to view (leave empty for your own)')
    .setRequired(false)
    .setAutocomplete(true)
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  manager: DraftManager
): Promise<void> {
  const teamOption = interaction.options.getString('team')?.toUpperCase();
  const teamAbbr = teamOption ?? manager.getUserTeam(interaction.user.id);
  if (!teamAbbr || !TEAMS[teamAbbr]) {
    const msg = teamOption ? `❌ Unknown team: ${teamOption}` : '❌ You do not have a registered team. Use `/draft register` to claim one, or specify a team name.';
    await interaction.reply({ content: msg, ephemeral: true });
    return;
  }

  const team = TEAMS[teamAbbr];
  const teamName = team?.name ?? teamAbbr;

  // ── 2026 Draft Picks ──────────────────────────────────────────────────────
  const picks = manager.getFuturePicksForTeam(teamAbbr);
  let picksText: string;
  if (picks.length === 0) {
    picksText = '_No remaining picks this draft_';
  } else {
    picksText = picks.map(p => {
      const via = p.isTraded ? ` *(via ${TEAMS[p.originalTeam]?.name ?? p.originalTeam})*` : '';
      return `**#${p.overall}** (${p.round}.${p.roundPick})${via}`;
    }).join('  ·  ');
    if (picksText.length > 1024) picksText = picksText.slice(0, 1021) + '…';
  }

  // ── Future Pick Rights ────────────────────────────────────────────────────
  const rights = manager.getFuturePickRightsForTeam(teamAbbr);
  const byYear = new Map<number, typeof rights>();
  for (const r of rights) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year)!.push(r);
  }
  let futureText = '';
  for (const [year, yearRights] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    const line = yearRights
      .sort((a, b) => a.round - b.round)
      .map(r => {
        const via = r.originalTeam !== teamAbbr
          ? ` *(via ${TEAMS[r.originalTeam]?.name ?? r.originalTeam})*`
          : '';
        return `R${r.round}${via}`;
      })
      .join(' · ');
    futureText += `**${year}:** ${line}\n`;
  }
  if (!futureText) futureText = '_None_';

  // ── Salary Cap ─────────────────────────────────────────────────────────────
  const hasSalaryData = Object.keys(TEAM_CAP).length > 0;
  let capText = '';
  if (hasSalaryData) {
    const capInfo = manager.trades.getTeamCapInfo(teamAbbr);
    capText = `**Cap Used:** $${formatCapAmount(capInfo.capUsed)}  ·  **Cap Space:** $${formatCapAmount(capInfo.capSpace)}`;
    if (capInfo.deadMoney > 0) {
      capText += `  ·  **Dead Money:** $${formatCapAmount(capInfo.deadMoney)}`;
    }
    if (capInfo.projectedRookieCap > 0) {
      capText += `\n**Effective Cap Space:** $${formatCapAmount(capInfo.effectiveCapSpace)} *(after $${formatCapAmount(capInfo.projectedRookieCap)} in projected rookie slots)*`;
    }
  }

  // ── Roster ────────────────────────────────────────────────────────────────
  const roster = manager.getFullRoster(teamAbbr);

  const embed = new EmbedBuilder()
    .setTitle(`📋 ${teamName} — Inventory`)
    .setColor(team?.color ?? 0x5865F2)
    .setFooter({ text: `GM: ${interaction.client.users.cache.get(manager.getState().assignments[teamAbbr] ?? '')?.displayName ?? 'unassigned'}` })
    .addFields(
      { name: '📅 2026 Draft Picks', value: picksText, inline: false },
      { name: '🔮 Future Pick Rights', value: futureText.trim() || '_None_', inline: false },
    );

  if (capText) {
    embed.addFields({ name: '💰 Salary Cap', value: capText, inline: false });
  }

  // Position group fields (inline — 3 per row on desktop)
  const allGroupedPos = new Set(POS_GROUPS.flatMap(g => g.positions));

  for (const group of POS_GROUPS) {
    const players = roster.filter(p => group.positions.includes(p.pos));
    if (players.length === 0) continue;
    const text = players
      .map(p => `${p.name}${p.number ? ` (#${p.number})` : ''}`)
      .join('\n');
    embed.addFields({ name: group.label, value: text.slice(0, 1024), inline: true });
  }

  const other = roster.filter(p => !allGroupedPos.has(p.pos));
  if (other.length > 0) {
    const text = other.map(p => `${p.name}${p.number ? ` (#${p.number})` : ''}`).join('\n');
    embed.addFields({ name: 'Other', value: text.slice(0, 1024), inline: true });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function autocomplete(
  interaction: AutocompleteInteraction,
  manager: DraftManager
): Promise<void> {
  const query = interaction.options.getFocused();
  await interaction.respond(manager.getTeamChoices(query));
}
