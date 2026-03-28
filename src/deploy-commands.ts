import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands/index';

const token    = process.env.DISCORD_TOKEN!;
const clientId = process.env.CLIENT_ID!;
const guildId  = process.env.GUILD_ID;   // set for fast guild-scoped deploy

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env');
  process.exit(1);
}

const rest = new REST().setToken(token);
const body = commands.map(cmd => cmd.data.toJSON());

(async () => {
  try {
    if (guildId) {
      // Guild deploy — instant (use during development)
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
      console.log(`✅ Registered ${body.length} guild commands for guild ${guildId}`);
    } else {
      // Global deploy — can take up to 1 hour to propagate
      await rest.put(Routes.applicationCommands(clientId), { body });
      console.log(`✅ Registered ${body.length} global commands`);
    }
  } catch (err) {
    console.error(err);
  }
})();
