import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { DraftManager } from './draft/DraftManager';
import { commandMap } from './commands/index';
import { isOllamaConfigured } from './llm/OllamaService';
import { buildIndex as buildEmbeddingIndex } from './llm/EmbeddingService';

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

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  clientReady = true;

  // Pre-fetch assigned users so display names are cached for embeds
  for (const [guildId] of c.guilds.cache) {
    try {
      const manager = await getManager(guildId);
      const state = manager.getState();
      const userIds = new Set<string>();
      for (const uid of Object.values(state.assignments)) userIds.add(uid);
      for (const coList of Object.values(state.coManagers)) {
        for (const uid of coList) userIds.add(uid);
      }
      const fetched = await Promise.allSettled(
        [...userIds].map(id => c.users.fetch(id))
      );
      const resolved = fetched.filter(r => r.status === 'fulfilled').length;
      console.log(`👥 Cached ${resolved}/${userIds.size} user names for guild ${guildId}`);
    } catch (err) {
      console.error(`Failed to pre-fetch users for guild ${guildId}:`, err);
    }
  }

  // Build RAG embedding index in background (non-blocking)
  if (isOllamaConfigured()) {
    buildEmbeddingIndex().catch(err =>
      console.error('[EmbeddingService] Failed to build index:', err)
    );
  }
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

  if (interaction.isButton()) {
    const customId = interaction.customId;
    try {
      if (customId.startsWith('cpu-offer-accept:')) {
        const offerId = customId.slice('cpu-offer-accept:'.length);
        await interaction.deferReply({ ephemeral: true });
        const result = await manager.aiGM.handleOfferAccept(offerId, interaction.user.id);
        if (result.success) {
          await interaction.editReply('Trade accepted!');
        } else {
          await interaction.editReply(`Could not accept: ${result.error}`);
        }
      } else if (customId.startsWith('cpu-offer-decline:')) {
        const offerId = customId.slice('cpu-offer-decline:'.length);
        await interaction.deferReply({ ephemeral: true });
        const result = await manager.aiGM.handleOfferDecline(offerId, interaction.user.id);
        if (result.success) {
          await interaction.editReply('Trade declined.');
        } else {
          await interaction.editReply(`Could not decline: ${result.error}`);
        }
      }
    } catch (err) {
      console.error('Button handler error:', err);
      try {
        const msg = { content: 'An error occurred processing this button.', ephemeral: true };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(msg);
        } else {
          await interaction.reply(msg);
        }
      } catch { /* expired */ }
    }
    return;
  }
});

client.login(token);
