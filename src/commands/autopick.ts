import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { DraftManager } from '../discord/DraftManager';
import { TEAMS } from '../data/teams';

export const data = new SlashCommandBuilder()
  .setName('autopick')
  .setDescription('Let the CPU pick the best available player for your team this turn');

export async function execute(
  interaction: ChatInputCommandInteraction,
  manager: DraftManager
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const result = await manager.autoPick(interaction.user.id);

  if (!result.success) {
    await interaction.editReply(`❌ ${result.error}`);
    return;
  }

  const pick = result.pick!;
  const team = TEAMS[pick.team];
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(team?.color ?? 0xFFB612)
        .setTitle('🤖 Auto-Pick Submitted!')
        .setDescription(`**${pick.prospectName}** (${pick.pos}, ${pick.school})\nRound ${pick.round}, Pick ${pick.roundPick} · Overall #${pick.overall}`)
    ]
  });

  // If draft completed, engine's draft:complete event handles embeds via adapter.
}
