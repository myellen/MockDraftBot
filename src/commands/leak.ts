import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder,
} from 'discord.js';
import { DraftManager } from '../discord/DraftManager';
import { TEAMS } from '../data/teams';
import { isOllamaConfigured, chatText } from '../llm/OllamaService';
import { INSIDERS, buildReporterPrompt } from './rumor';

// ── Command ─────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName('leak')
  .setDescription('Leak intel to an NFL insider and watch them tweet it')
  .addStringOption(opt =>
    opt
      .setName('info')
      .setDescription('The intel you want to leak (e.g. "The Bears are desperate to trade up")')
      .setRequired(true),
  )
  .addStringOption(opt =>
    opt
      .setName('insider')
      .setDescription('Which insider gets the scoop (random if not specified)')
      .setRequired(false)
      .setAutocomplete(true),
  );

export async function autocomplete(
  interaction: AutocompleteInteraction,
  _manager: DraftManager,
): Promise<void> {
  const focused = interaction.options.getFocused().toLowerCase();
  const choices = INSIDERS
    .filter(i => !focused || i.name.toLowerCase().includes(focused) || i.handle.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(i => ({ name: `${i.name} (${i.handle})`, value: i.name }));
  await interaction.respond(choices);
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  manager: DraftManager,
): Promise<void> {
  if (!isOllamaConfigured()) {
    await interaction.reply({
      content: '❌ AI features are not configured. Set `OLLAMA_HOST` and `OLLAMA_MODEL` in your `.env` file.',
      ephemeral: true,
    });
    return;
  }

  const info = interaction.options.getString('info', true);
  const insiderName = interaction.options.getString('insider');

  const insider = insiderName
    ? INSIDERS.find(i => i.name === insiderName) ?? INSIDERS[Math.floor(Math.random() * INSIDERS.length)]
    : INSIDERS[Math.floor(Math.random() * INSIDERS.length)];

  await interaction.deferReply({ ephemeral: true });

  try {
    // Build draft context so the reporter can ground the leak in reality
    const state = manager.getState();
    const teamNames: Record<string, string> = {};
    for (const [abbr, team] of Object.entries(TEAMS)) {
      teamNames[abbr] = team.name;
    }

    const slot = manager.getCurrentSlot();
    const pickContext = slot
      ? `Current pick: Round ${slot.round}, Overall #${slot.overall} — ${teamNames[slot.currentTeam] ?? slot.currentTeam} on the clock.`
      : state.status === 'active' ? 'Draft is active.' : 'Draft is not currently active.';

    const recentPicks = manager.getLastNPicks(5).map(p =>
      `${teamNames[p.team] ?? p.team}: ${p.prospectName} (${p.pos}) in Round ${p.round}`
    ).join('; ');

    // Figure out which team the leaker is GM of
    const userId = interaction.user.id;
    const leakerTeam = Object.entries(state.assignments).find(([, uid]) => uid === userId)?.[0];
    const leakerLabel = leakerTeam ? `a source within the ${teamNames[leakerTeam] ?? leakerTeam} organization` : 'an NFL source';

    const reporterPrompt = buildReporterPrompt(insider);
    const reporterInput = `Draft context: ${pickContext}${recentPicks ? ` Recent picks: ${recentPicks}.` : ''}\n\nA GM/source leaked you the following intel. Remember: you are the REPORTER, not the source. Translate their words into your reporting voice.\nSource (${leakerLabel}) says: "${info}"`;

    let tweet = await chatText(reporterPrompt, reporterInput, 1.2);

    // Strip any quotes the model may have wrapped around the tweet
    tweet = tweet.replace(/^["'""'']|["'""'']$/g, '').trim();

    // Truncate to 280 chars if needed
    if (tweet.length > 280) {
      tweet = tweet.slice(0, 277) + '...';
    }

    console.log(`[leak] ${insider.name} tweet (${tweet.length} chars): ${tweet}`);

    const embed = new EmbedBuilder()
      .setAuthor({ name: `${insider.name} (${insider.handle})`, iconURL: insider.avatar })
      .setDescription(tweet)
      .setColor(0x1DA1F2)
      .setFooter({ text: '𝕏' })
      .setTimestamp();

    // Register leak so AI GMs factor it into trade decisions
    manager.aiGM.addLeak(leakerTeam ?? null, info, tweet);

    await interaction.editReply('🤫 Your leak has been anonymized and passed to an insider. Only they know who talked.');
    await interaction.followUp({ embeds: [embed] });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[leak] Error:', message);
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      await interaction.editReply('❌ Could not connect to Ollama. Make sure the Ollama server is running.');
    } else {
      await interaction.editReply(`❌ Failed to generate leak: ${message.slice(0, 200)}`);
    }
  }
}
