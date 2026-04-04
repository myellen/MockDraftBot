import { ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';

const SUPER_ADMINS = new Set([
  'REDACTED_USER_ID', // Max
]);

export function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  if (SUPER_ADMINS.has(interaction.user.id)) return true;
  if (!interaction.memberPermissions) return false;
  return interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
}
