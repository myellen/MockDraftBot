import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { DraftManager } from './draft/DraftManager';
import { commandMap } from './commands/index';

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('Missing DISCORD_TOKEN in environment');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let manager: DraftManager;

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  manager = await DraftManager.load(client);
  console.log(`📋 Draft state loaded (status: ${manager.getState().status})`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!manager) return; // not ready yet

  if (interaction.isChatInputCommand()) {
    const command = commandMap.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction, manager);
    } catch (err) {
      console.error(`Error in /${interaction.commandName}:`, err);
      const msg = { content: '❌ An error occurred. Please try again.', ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
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
