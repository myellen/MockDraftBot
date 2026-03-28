import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { DraftManager } from '../draft/DraftManager';
import { ALL_POSITIONS } from '../data/prospects';
import { buildBoardEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('board')
  .setDescription('View available draft prospects')
  .addStringOption(opt => opt
    .setName('position')
    .setDescription('Filter by position')
    .setRequired(false)
    .addChoices(
      { name: 'QB', value: 'QB' },
      { name: 'RB', value: 'RB' },
      { name: 'WR', value: 'WR' },
      { name: 'TE', value: 'TE' },
      { name: 'OT', value: 'OT' },
      { name: 'OG', value: 'OG' },
      { name: 'C',  value: 'C'  },
      { name: 'EDGE', value: 'EDGE' },
      { name: 'DE', value: 'DE' },
      { name: 'DT', value: 'DT' },
      { name: 'LB', value: 'LB' },
      { name: 'CB', value: 'CB' },
      { name: 'S',  value: 'S'  },
      { name: 'K',  value: 'K'  },
      { name: 'P',  value: 'P'  },
    )
  )
  .addIntegerOption(opt => opt
    .setName('page')
    .setDescription('Page number (default: 1)')
    .setMinValue(1)
    .setRequired(false)
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  manager: DraftManager
): Promise<void> {
  const pos = interaction.options.getString('position') ?? undefined;
  const page = interaction.options.getInteger('page') ?? 1;

  const { prospects, totalPages, total } = manager.getAvailableProspects(pos, page);
  const embed = buildBoardEmbed(prospects, page, totalPages, total, pos);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
