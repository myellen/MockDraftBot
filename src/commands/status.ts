import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { DraftManager } from '../discord/DraftManager';
import { TEAMS } from '../data/teams';
import { buildStatusEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Show current draft status, who is on the clock, and recent picks');

export async function execute(
  interaction: ChatInputCommandInteraction,
  manager: DraftManager
): Promise<void> {
  const state = manager.getState();
  const slot = manager.getCurrentSlot();
  const currentTeam = slot ? (TEAMS[slot.currentTeam] ?? null) : null;
  const gmLabel = slot ? manager.getTeamGMLabel(slot.currentTeam) : null;
  const timeRemaining = manager.getTimeRemaining();
  const lastPicks = manager.getLastNPicks(5);

  const embed = buildStatusEmbed(
    state.status,
    slot,
    currentTeam,
    gmLabel === '_unassigned_' ? null : gmLabel,
    timeRemaining,
    lastPicks,
    state.schedule.filter(s => s.round <= (state.config.rounds ?? 7)).length,
    state.picks.length
  );

  await interaction.reply({ embeds: [embed] });
}
