import { ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';

const SUPER_ADMINS = new Set(
  (process.env.SUPER_ADMINS ?? '').split(',').map(s => s.trim()).filter(Boolean)
);

export function isAdmin(interaction: ChatInputCommandInteraction): boolean {
  if (SUPER_ADMINS.has(interaction.user.id)) return true;
  if (!interaction.memberPermissions) return false;
  return interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
}
