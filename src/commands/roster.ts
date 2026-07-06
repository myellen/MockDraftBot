import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder } from 'discord.js';
import { DraftManager } from '../discord/DraftManager';
import { TEAMS } from '../data/teams';
import { buildTeamRosterEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('roster')
  .setDescription("View a team's draft picks so far")
  .addStringOption(opt => opt
    .setName('team')
    .setDescription('Team abbreviation (start typing to search)')
    .setRequired(true)
    .setAutocomplete(true)
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  manager: DraftManager
): Promise<void> {
  const abbr = interaction.options.getString('team', true).toUpperCase();

  if (!TEAMS[abbr]) {
    await interaction.reply({ content: `❌ Unknown team: ${abbr}`, ephemeral: true });
    return;
  }

  const picks = manager.getTeamPicks(abbr);
  const embed = buildTeamRosterEmbed(TEAMS[abbr], abbr, picks);
  await interaction.reply({ embeds: [embed], ephemeral: false });
}

export async function autocomplete(
  interaction: AutocompleteInteraction,
  manager: DraftManager
): Promise<void> {
  const query = interaction.options.getFocused();
  await interaction.respond(manager.getTeamChoices(query));
}
