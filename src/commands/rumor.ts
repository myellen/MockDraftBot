import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { DraftManager } from '../discord/DraftManager';
import { TEAMS } from '../data/teams';
import { isOllamaConfigured, chatJSON, chatText } from '../llm/OllamaService';
import { INSIDERS, buildLeakerPrompt, buildReporterPrompt } from '../llm/insiderData';
import type { Insider } from '../llm/insiderData';

export { INSIDERS, buildLeakerPrompt, buildReporterPrompt };
export type { Insider };

// ── Leaker types (local to command) ────────────────────────────────────────

interface LeakerNugget {
  nugget: string;
  teams: string[];
  spiciness: number;
}

interface LeakerResponse {
  nuggets: LeakerNugget[];
}

// ── Insider trade announcement helper ───────────────────────────────────────

/**
 * Generate an insider-style embed announcing a trade proposal.
 * Used by trade.ts and trade-ai.ts when tradeAnnouncement === 'insider'.
 */
export async function buildInsiderTradeEmbed(
  receiverTeamName: string,
): Promise<EmbedBuilder> {
  const insider = INSIDERS[Math.floor(Math.random() * INSIDERS.length)];
  const prompt = buildReporterPrompt(insider);
  const input = `A source within the ${receiverTeamName} organization tells you they just received a trade offer and are evaluating it. Write a tweet breaking this news. End the tweet by telling people to check /trade list to see what's on the table — work it into your voice naturally (e.g. "Details dropping soon — check /trade list" or "👀 /trade list for the full picture").`;

  let tweet: string;
  try {
    tweet = await chatText(prompt, input, 1.2);
    tweet = tweet.replace(/^["'""'']|["'""'']$/g, '').trim();
    if (tweet.length > 280) tweet = tweet.slice(0, 277) + '...';
  } catch {
    // Fallback if LLM is down
    tweet = `I'm hearing the ${receiverTeamName} have received a trade offer. Stay tuned. 👀 Check /trade list`;
  }

  return new EmbedBuilder()
    .setAuthor({ name: `${insider.name} (${insider.handle})`, iconURL: insider.avatar })
    .setDescription(tweet)
    .setColor(0x1DA1F2)
    .setFooter({ text: '𝕏' })
    .setTimestamp();
}

// ── Command ─────────────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName('rumor')
  .setDescription('Generate an NFL insider-style rumor tweet based on current draft activity');

export async function execute(
  interaction: ChatInputCommandInteraction,
  manager: DraftManager
): Promise<void> {
  if (!isOllamaConfigured()) {
    await interaction.reply({
      content: '❌ AI features are not configured. Set `OLLAMA_HOST` and `OLLAMA_MODEL` in your `.env` file.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    // ── Gather draft intel ──
    const state = manager.getState();
    const teamNames: Record<string, string> = {};
    for (const [abbr, team] of Object.entries(TEAMS)) {
      teamNames[abbr] = team.name;
    }

    const recentTrades = (state.tradeHistory ?? []).slice(-15).map(t => ({
      proposerTeam: t.proposerTeam,
      receiverTeam: t.receiverTeam,
      offeredOveralls: t.offeredOveralls,
      requestedOveralls: t.requestedOveralls,
      offeredPlayers: t.offeredPlayers ?? [],
      requestedPlayers: t.requestedPlayers ?? [],
      offeredFuturePicks: t.offeredFuturePicks ?? [],
      requestedFuturePicks: t.requestedFuturePicks ?? [],
    }));

    const cancelledTrades = (state.cancelledTrades ?? []).slice(-15).map(t => ({
      proposerTeam: t.proposerTeam,
      receiverTeam: t.receiverTeam,
      cancelReason: t.cancelReason,
      offeredOveralls: t.offeredOveralls,
      requestedOveralls: t.requestedOveralls,
      offeredPlayers: t.offeredPlayers ?? [],
      requestedPlayers: t.requestedPlayers ?? [],
      offeredFuturePicks: t.offeredFuturePicks ?? [],
      requestedFuturePicks: t.requestedFuturePicks ?? [],
    }));

    const pendingTrades = (state.pendingTrades ?? []).map(t => ({
      proposerTeam: t.proposerTeam,
      receiverTeam: t.receiverTeam,
      offeredOveralls: t.offeredOveralls,
      requestedOveralls: t.requestedOveralls,
      offeredPlayers: t.offeredPlayers ?? [],
      requestedPlayers: t.requestedPlayers ?? [],
      offeredFuturePicks: t.offeredFuturePicks ?? [],
      requestedFuturePicks: t.requestedFuturePicks ?? [],
    }));

    // Collect strategy notes from board data
    const strategyNotes: Record<string, string[]> = {};
    for (const abbr of Object.keys(TEAMS)) {
      const notes = manager.getStrategyNotes(abbr);
      if (notes.length > 0) strategyNotes[abbr] = notes;
    }

    // Recent draft picks
    const recentPicks = manager.getLastNPicks(10).map(p => ({
      team: p.team,
      prospectName: p.prospectName,
      pos: p.pos,
      school: p.school,
      round: p.round,
      overall: p.overall,
    }));

    const slot = manager.getCurrentSlot();
    const currentPick = slot ? { overall: slot.overall, round: slot.round, team: slot.currentTeam } : null;

    // ── Step 1: Leaker extracts nuggets ──
    const leakerPrompt = buildLeakerPrompt(
      recentTrades, cancelledTrades, pendingTrades,
      recentPicks, strategyNotes, currentPick, teamNames,
    );

    console.log(`[rumor] Leaker prompt: ${leakerPrompt.length} chars`);
    const leakerResult = await chatJSON<LeakerResponse>(leakerPrompt, 'Analyze the draft activity and extract the most interesting nuggets.');

    console.log(`[rumor] Leaker found ${leakerResult.nuggets?.length ?? 0} nuggets`);

    // Pick the spiciest nugget (with some randomness among the top ones)
    const insider = INSIDERS[Math.floor(Math.random() * INSIDERS.length)];
    const reporterPrompt = buildReporterPrompt(insider);

    let reporterInput: string;

    if (leakerResult.nuggets && leakerResult.nuggets.length > 0) {
      const sorted = leakerResult.nuggets.sort((a, b) => b.spiciness - a.spiciness);
      const topTier = sorted.filter(n => n.spiciness >= sorted[0].spiciness - 1);
      const chosen = topTier[Math.floor(Math.random() * topTier.length)];
      reporterInput = `Write a tweet based on this intel: ${chosen.nugget}`;
      console.log(`[rumor] Reporter: ${insider.name}, nugget: "${chosen.nugget}"`);
    } else {
      // Fallback: let the reporter freestyle based on raw context
      const fallbackContext = recentPicks.length > 0
        ? `A recent pick: the ${teamNames[recentPicks[0].team]} selected ${recentPicks[0].prospectName} (${recentPicks[0].pos}, ${recentPicks[0].school}) in round ${recentPicks[0].round}. The front office loved this player and had a much higher grade on him than where he was taken.`
        : 'Pre-draft buzz: teams are actively working the phones and evaluating prospects. Generate a vague but exciting rumor about draft day preparations.';
      reporterInput = `Write a tweet based on this intel: ${fallbackContext}`;
      console.log(`[rumor] Reporter (fallback): ${insider.name}`);
    }

    let tweet = await chatText(reporterPrompt, reporterInput, 1.2);

    // Strip any quotes the model may have wrapped around the tweet
    tweet = tweet.replace(/^["'""'']|["'""'']$/g, '').trim();

    // Truncate to 280 chars if needed
    if (tweet.length > 280) {
      tweet = tweet.slice(0, 277) + '...';
    }

    console.log(`[rumor] Tweet (${tweet.length} chars): ${tweet}`);

    // ── Build tweet-style embed ──
    const embed = new EmbedBuilder()
      .setAuthor({ name: `${insider.name} (${insider.handle})`, iconURL: insider.avatar })
      .setDescription(tweet)
      .setColor(0x1DA1F2)
      .setFooter({ text: '𝕏' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[rumor] Error:', message);
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      await interaction.editReply('❌ Could not connect to Ollama. Make sure the Ollama server is running.');
    } else {
      await interaction.editReply(`❌ Failed to generate rumor: ${message.slice(0, 200)}`);
    }
  }
}
