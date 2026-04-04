import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { DraftManager } from './draft/DraftManager';
import { commandMap } from './commands/index';

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('Missing DISCORD_TOKEN in environment');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const managers = new Map<string, DraftManager>();
let clientReady = false;

async function getManager(guildId: string): Promise<DraftManager> {
  if (!managers.has(guildId)) {
    const m = await DraftManager.load(client, guildId);
    managers.set(guildId, m);
    console.log(`📋 Loaded draft state for guild ${guildId} (status: ${m.getState().status})`);
  }
  return managers.get(guildId)!;
}

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  clientReady = true;
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!clientReady || !interaction.guildId) return;

  const manager = await getManager(interaction.guildId);

  if (interaction.isChatInputCommand()) {
    const command = commandMap.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction, manager);
    } catch (err) {
      console.error(`Error in /${interaction.commandName}:`, err);
      try {
        const msg = { content: '❌ An error occurred. Please try again.', ephemeral: true };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(msg);
        } else {
          await interaction.reply(msg);
        }
      } catch { /* interaction expired or already handled */ }
    }
    return;
  }

  if (interaction.isAutocomplete()) {
    const command = commandMap.get(interaction.commandName);
    if (!command?.autocomplete) return;
    try {
      await command.autocomplete(interaction, manager);
    } catch (err) {
      console.error(`Autocomplete error in /${interaction.commandName}:`, err);
    }
    return;
  }
});

client.login(token);
