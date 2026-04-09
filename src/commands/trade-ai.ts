import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import { DraftManager, formatCapAmount } from '../draft/DraftManager';
import { TEAMS } from '../data/teams';
import { SALARIES } from '../data/salaries';
import { isOllamaConfigured, chatJSON } from '../llm/OllamaService';
import { buildPendingTradesEmbed, buildTradeExecutedEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('trade-ai')
  .setDescription('Describe a trade in plain English and let the AI build the proposal')
  .addStringOption(opt => opt
    .setName('description')
    .setDescription('Describe the trade you want (e.g. "trade my 1st round pick to the Cowboys for their 2nd and 4th")')
    .setRequired(true)
  );

interface TradeAIResponse {
  targetTeam: string;
  offeredPicks: number[];
  requestedPicks: number[];
  offeredPlayers: string[];
  requestedPlayers: string[];
  offeredFuturePicks: string[];
  requestedFuturePicks: string[];
  explanation: string;
  error?: string;
}

function buildTradeSystemPrompt(
  myTeam: string,
  myTeamName: string,
  myPicks: Array<{ overall: number; round: number; roundPick: number; originalTeam: string }>,
  myPlayers: Array<{ name: string; pos: string }>,
  myFuturePicks: Array<{ id: string; year: number; round: number; originalTeam: string }>,
  allTeams: Record<string, { name: string; abbr: string }>,
  allPicksByTeam: Record<string, Array<{ overall: number; round: number; roundPick: number }>>,
  allFuturePicksByTeam: Record<string, Array<{ id: string; year: number; round: number; originalTeam: string }>>,
): string {
  const teamList = Object.entries(allTeams)
    .map(([abbr, t]) => `${abbr} = ${t.name}`)
    .join('\n');

  const myPicksStr = myPicks.length > 0
    ? myPicks.map(p => `  #${p.overall} (Round ${p.round}, Pick ${p.roundPick}${p.originalTeam !== myTeam ? ` — via ${p.originalTeam}` : ''})`).join('\n')
    : '  (none)';

  const myPlayersStr = myPlayers.length > 0
    ? myPlayers.slice(0, 30).map(p => `  ${p.name} (${p.pos})`).join('\n')
    : '  (none)';

  const myFutureStr = myFuturePicks.length > 0
    ? myFuturePicks.map(f => `  ${f.year} Round ${f.round} (orig: ${f.originalTeam})`).join('\n')
    : '  (none)';

  // Build other teams' picks summary (compact)
  const otherTeamPicks = Object.entries(allPicksByTeam)
    .filter(([abbr]) => abbr !== myTeam)
    .map(([abbr, picks]) => {
      const pickStr = picks.map(p => `#${p.overall}(R${p.round})`).join(', ');
      return `  ${abbr}: ${pickStr || '(none)'}`;
    })
    .join('\n');

  return `You are an NFL trade assistant for a mock draft Discord bot. Your job is to parse a natural-language trade description into structured trade data.

The user controls the **${myTeamName} (${myTeam})**.

## NFL Teams
${teamList}

## ${myTeam}'s Available Draft Picks (current year)
${myPicksStr}

## ${myTeam}'s Roster Players (tradeable)
${myPlayersStr}

## ${myTeam}'s Future Pick Rights
${myFutureStr}

## Other Teams' Available Picks
${otherTeamPicks}

## Rules
- "offeredPicks" and "requestedPicks" use OVERALL pick numbers (not round.pick notation)
- "offeredPlayers" and "requestedPlayers" use exact player names as shown above
- "offeredFuturePicks" and "requestedFuturePicks" use format like "2027R1", "2028R3"
- "offered" means what the user's team GIVES UP
- "requested" means what the user's team RECEIVES
- "targetTeam" is the OTHER team's abbreviation (e.g. "DAL", "NYJ")
- If the user says "my 1st round pick" they mean their team's Round 1 pick from the picks listed above
- If the user says "their 2nd rounder" they mean the target team's Round 2 pick
- If you cannot determine the trade, set "error" to a helpful message explaining what's unclear
- Match player names fuzzily — if they say "Mahomes" match to the full name "Patrick Mahomes" from the roster
- Match team names fuzzily — "Cowboys" = "DAL", "Niners" or "49ers" = "SF", etc.

## Response Format
Respond with ONLY valid JSON in this exact format:
{
  "targetTeam": "TEAM_ABBR",
  "offeredPicks": [overall_numbers],
  "requestedPicks": [overall_numbers],
  "offeredPlayers": ["Player Name"],
  "requestedPlayers": ["Player Name"],
  "offeredFuturePicks": ["2027R1"],
  "requestedFuturePicks": [],
  "explanation": "Brief explanation of the trade",
  "error": null
}`;
}

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

  const state = manager.getState();
  if (state.status !== 'active' && state.status !== 'paused') {
    await interaction.reply({ content: '❌ No active draft. Start a draft first.', ephemeral: true });
    return;
  }

  const userTeam = manager.getUserTeam(interaction.user.id);
  if (!userTeam) {
    await interaction.reply({ content: '❌ You need a registered team to propose trades.', ephemeral: true });
    return;
  }

  const description = interaction.options.getString('description', true);
  await interaction.deferReply({ ephemeral: true });

  try {
    // Gather context for the LLM
    const myPicks = manager.getFuturePicksForTeam(userTeam).map(s => ({
      overall: s.overall,
      round: s.round,
      roundPick: s.roundPick,
      originalTeam: s.originalTeam,
    }));

    const myPlayers = manager.searchRosterPlayers(userTeam, '');
    const myFuturePicks = manager.getFuturePickRightsForTeam(userTeam).map(f => ({
      id: f.id,
      year: f.year,
      round: f.round,
      originalTeam: f.originalTeam,
    }));

    // Build other teams' picks for reference
    const allPicksByTeam: Record<string, Array<{ overall: number; round: number; roundPick: number }>> = {};
    const allFuturePicksByTeam: Record<string, Array<{ id: string; year: number; round: number; originalTeam: string }>> = {};
    for (const abbr of Object.keys(TEAMS)) {
      allPicksByTeam[abbr] = manager.getFuturePicksForTeam(abbr).map(s => ({
        overall: s.overall,
        round: s.round,
        roundPick: s.roundPick,
      }));
      allFuturePicksByTeam[abbr] = manager.getFuturePickRightsForTeam(abbr).map(f => ({
        id: f.id,
        year: f.year,
        round: f.round,
        originalTeam: f.originalTeam,
      }));
    }

    const systemPrompt = buildTradeSystemPrompt(
      userTeam,
      TEAMS[userTeam]?.name ?? userTeam,
      myPicks,
      myPlayers,
      myFuturePicks,
      TEAMS,
      allPicksByTeam,
      allFuturePicksByTeam,
    );

    const result = await chatJSON<TradeAIResponse>(systemPrompt, description);

    if (result.error) {
      await interaction.editReply(`❌ AI couldn't parse your trade: ${result.error}`);
      return;
    }

    // Validate target team
    if (!result.targetTeam || !TEAMS[result.targetTeam]) {
      await interaction.editReply(`❌ AI returned an invalid team: "${result.targetTeam}". Try being more specific about which team.`);
      return;
    }

    // Find the receiver's userId
    const receiverUserId = state.assignments[result.targetTeam];
    if (!receiverUserId) {
      await interaction.editReply(`❌ The **${TEAMS[result.targetTeam]?.name}** don't have a registered GM. No one to trade with.`);
      return;
    }

    // Parse future picks into IDs
    const parseFuturePickStr = (s: string, teamAbbr: string): string | null => {
      const m = s.match(/^(\d{4})[Rr](\d)$/);
      if (!m) return null;
      const year = parseInt(m[1], 10);
      const round = parseInt(m[2], 10);
      const right = manager.resolveFuturePickRight(teamAbbr, year, round);
      return right?.id ?? null;
    };

    const offeredFutureIds: string[] = [];
    for (const fp of result.offeredFuturePicks ?? []) {
      const id = parseFuturePickStr(fp, userTeam);
      if (!id) {
        await interaction.editReply(`❌ AI suggested offering future pick "${fp}" but it wasn't found on your team. Try rephrasing.`);
        return;
      }
      offeredFutureIds.push(id);
    }

    const requestedFutureIds: string[] = [];
    for (const fp of result.requestedFuturePicks ?? []) {
      const id = parseFuturePickStr(fp, result.targetTeam);
      if (!id) {
        await interaction.editReply(`❌ AI suggested requesting future pick "${fp}" but it wasn't found on ${TEAMS[result.targetTeam]?.name}. Try rephrasing.`);
        return;
      }
      requestedFutureIds.push(id);
    }

    // Build a summary for the user to review
    const formatSide = (picks: number[], players: string[], futures: string[]): string => {
      const parts: string[] = [];
      if (picks.length) parts.push(`picks **#${picks.join(', #')}**`);
      if (players.length) parts.push(`players **${players.join(', ')}**`);
      if (futures.length) parts.push(`future picks **${futures.join(', ')}**`);
      return parts.join(' + ') || '_nothing_';
    };

    const myTeamName = TEAMS[userTeam]?.name ?? userTeam;
    const targetTeamName = TEAMS[result.targetTeam]?.name ?? result.targetTeam;

    const summary = [
      `**AI Trade Proposal** (from your description)`,
      ``,
      `**${myTeamName}** send: ${formatSide(result.offeredPicks ?? [], result.offeredPlayers ?? [], result.offeredFuturePicks ?? [])}`,
      `**${targetTeamName}** send: ${formatSide(result.requestedPicks ?? [], result.requestedPlayers ?? [], result.requestedFuturePicks ?? [])}`,
      ``,
      `> ${result.explanation}`,
      ``,
      `Submitting trade proposal...`,
    ].join('\n');

    await interaction.editReply(summary);

    // Actually propose the trade
    const tradeResult = await manager.trades.proposeTrade(
      interaction.user.id,
      receiverUserId,
      result.offeredPicks ?? [],
      result.requestedPicks ?? [],
      result.offeredPlayers ?? [],
      result.requestedPlayers ?? [],
      offeredFutureIds,
      requestedFutureIds,
    );

    if (!tradeResult.success) {
      await interaction.followUp({
        content: `❌ Trade proposal failed: ${tradeResult.error}`,
        ephemeral: true,
      });
      return;
    }

    const trade = tradeResult.trade!;

    // Show cap impact if relevant
    let capText = '';
    if (Object.keys(SALARIES).length > 0) {
      const impact = manager.trades.calculateTradeCapImpact(trade);
      const fmtDelta = (d: number) => d >= 0 ? `+$${formatCapAmount(d)}` : `-$${formatCapAmount(Math.abs(d))}`;
      capText = `\n**Cap Impact:** ${myTeamName}: ${fmtDelta(impact.proposerCapChange)} | ${targetTeamName}: ${fmtDelta(impact.receiverCapChange)}`;

      const capCheck = manager.trades.validateTradeCap(trade);
      if (capCheck.warnings.length > 0) {
        capText += `\n⚠️ ${capCheck.warnings.join('\n⚠️ ')}`;
      }
    }

    await interaction.followUp({
      content: `✅ Trade proposed! (ID: **${trade.id}**)${capText}\n<@${receiverUserId}> can accept with \`/trade accept ${trade.id}\``,
      ephemeral: false,
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      await interaction.editReply('❌ Could not connect to Ollama. Make sure the Ollama server is running and `OLLAMA_HOST` is correct.');
    } else if (message.includes('JSON')) {
      await interaction.editReply('❌ AI returned an invalid response. Try rephrasing your trade description.');
    } else {
      await interaction.editReply(`❌ AI error: ${message}`);
    }
  }
}
