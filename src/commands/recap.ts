import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { DraftManager } from '../draft/DraftManager';

export const data = new SlashCommandBuilder()
  .setName('recap')
  .setDescription('Get the link to the live draft recap spreadsheet');

export async function execute(
  interaction: ChatInputCommandInteraction,
  _manager: DraftManager
): Promise<void> {
  await interaction.reply(
    '📊 **Live Draft Recap**\nhttps://docs.google.com/spreadsheets/d/1x4His-fAI4f32Fmxa1cyt78BRTXpo0l6ei5EmZ7p5ao/htmlview'
  );
}
