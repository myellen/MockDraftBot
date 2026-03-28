import { ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';

export function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  if (!interaction.memberPermissions) return false;
  return interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
}
