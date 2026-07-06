import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { DraftManager } from '../discord/DraftManager';
import { TEAMS } from '../data/teams';
import { ordinal } from '../utils/ordinal';
import { TEAM_EMOJI } from '../utils/teamEmoji';

export const data = new SlashCommandBuilder()
  .setName('upcoming')
  .setDescription('Show the next upcoming picks')
  .addIntegerOption(opt => opt
    .setName('count')
    .setDescription('Number of picks to show (default: 10)')
    .setMinValue(1)
    .setMaxValue(25)
    .setRequired(false)
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  manager: DraftManager
): Promise<void> {
  const state = manager.getState();
  if (state.status !== 'active' && state.status !== 'paused') {
    await interaction.reply({ content: '❌ No active draft.', ephemeral: true });
    return;
  }

  const count = interaction.options.getInteger('count') ?? 10;
  const upcoming = state.schedule.slice(state.currentPickIndex, state.currentPickIndex + count);

  if (!upcoming.length) {
    await interaction.reply({ content: 'No more picks remaining.', ephemeral: true });
    return;
  }

  const lines = upcoming.map((slot, i) => {
    const team = TEAMS[slot.currentTeam];
    const teamName = team?.name ?? slot.currentTeam;
    const gm = manager.getTeamGMLabel(slot.currentTeam);
    const traded = slot.isTraded ? ' *(traded)*' : '';
    const emoji = TEAM_EMOJI[slot.currentTeam] ?? '⬜';
    const arrow = i === 0 ? '➡️ ' : '';
    return `${arrow}${emoji} **${ordinal(slot.overall)}** (R${slot.round}P${slot.roundPick}) — ${teamName} · ${gm}${traded}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xFFB612)
    .setTitle('📋 Upcoming Picks')
    .setDescription(lines.join('\n'));

  await interaction.reply({ embeds: [embed] });
}
