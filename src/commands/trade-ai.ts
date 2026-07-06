import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { DraftManager, formatCapAmount } from '../discord/DraftManager';
import { TEAMS } from '../data/teams';
import { TEAM_CAP } from '../data/capData';
import { buildTradeChartUrl } from '../utils/embeds';
import { ConversationHistory } from '../utils/conversationHistory';
import { isOllamaConfigured, chatJSONWithHistory } from '../llm/OllamaService';
import { buildInsiderTradeEmbed } from './rumor';

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
  clarification?: string;
  error?: string;
}

// ── In-memory conversation history per user (resets on restart) ──
const conversations = new ConversationHistory(6); // keep last 3 exchanges

/**
 * Build a full context snapshot for the LLM trade agent.
 * Treat it like a fresh agent — give it everything it needs in one shot.
 */
function buildTradeSystemPrompt(
  myTeam: string,
  myTeamName: string,
  myPicks: Array<{ overall: number; round: number; roundPick: number; originalTeam: string }>,
  myRoster: Array<{ name: string; pos: string }>,
  myFuturePicks: Array<{ id: string; year: number; round: number; originalTeam: string }>,
  myDraftedPlayers: Array<{ prospectName: string; pos: string; overall: number }>,
  targetTeamPicks: Record<string, Array<{ overall: number; round: number; roundPick: number; originalTeam: string }>>,
  targetTeamRosters: Record<string, Array<{ name: string; pos: string }>>,
  targetTeamFuturePicks: Record<string, Array<{ year: number; round: number; originalTeam: string }>>,
  completedPicks: Array<{ overall: number; team: string; prospectName: string; pos: string }>,
): string {
  const teamList = Object.entries(TEAMS)
    .map(([abbr, t]) => `${abbr} = ${t.name}`)
    .join('\n');

  // ── My team's full context ──
  const myPicksStr = myPicks.length > 0
    ? myPicks.map(p => `  #${p.overall} (Round ${p.round}, Pick ${p.roundPick}${p.originalTeam !== myTeam ? ` — via ${p.originalTeam}` : ''})`).join('\n')
    : '  (none)';

  const myRosterStr = myRoster.length > 0
    ? myRoster.map(p => `  ${p.name} (${p.pos})`).join('\n')
    : '  (none)';

  const myFutureStr = myFuturePicks.length > 0
    ? myFuturePicks.map(f => `  ${f.year} Round ${f.round} (orig: ${f.originalTeam})`).join('\n')
    : '  (none)';

  const myDraftedStr = myDraftedPlayers.length > 0
    ? myDraftedPlayers.map(p => `  #${p.overall}: ${p.prospectName} (${p.pos})`).join('\n')
    : '  (none yet)';

  // ── Other teams' context (picks + rosters) ──
  const otherTeamsContext = Object.keys(TEAMS)
    .filter(abbr => abbr !== myTeam)
    .map(abbr => {
      const name = TEAMS[abbr].name;
      const picks = targetTeamPicks[abbr] ?? [];
      const roster = targetTeamRosters[abbr] ?? [];
      const futures = targetTeamFuturePicks[abbr] ?? [];

      const picksStr = picks.length > 0
        ? picks.map(p => `#${p.overall}(R${p.round}.${p.roundPick}${p.originalTeam !== abbr ? ` via ${p.originalTeam}` : ''})`).join(', ')
        : '(none)';

      const rosterStr = roster.length > 0
        ? roster.map(p => `${p.name} (${p.pos})`).join(', ')
        : '(none loaded)';

      const futureStr = futures.length > 0
        ? futures.map(f => {
            const via = f.originalTeam !== abbr ? ` (via ${f.originalTeam})` : '';
            return `${f.year}R${f.round}${via}`;
          }).join(', ')
        : '';

      let section = `### ${name} (${abbr})\n  Picks: ${picksStr}\n  Roster: ${rosterStr}`;
      if (futureStr) section += `\n  Future picks: ${futureStr}`;
      return section;
    })
    .join('\n\n');

  // ── Recent draft activity ──
  const recentPicksStr = completedPicks.length > 0
    ? completedPicks.slice(-15).map(p => `  #${p.overall} ${p.team}: ${p.prospectName} (${p.pos})`).join('\n')
    : '  (no picks made yet)';

  return `You are an NFL trade assistant for a mock draft Discord bot. Your job is to parse a natural-language trade description into structured trade data.

You are a stateless agent — all the information you need is in this prompt.

The user controls the **${myTeamName} (${myTeam})**.

## NFL Teams
${teamList}

## MY TEAM: ${myTeamName} (${myTeam})

### Available Draft Picks (current year)
${myPicksStr}

### Roster Players (tradeable)
${myRosterStr}

### Future Pick Rights (2027-2028)
${myFutureStr}

### Players Already Drafted This Session
${myDraftedStr}

## OTHER TEAMS

${otherTeamsContext}

## Recent Draft Picks
${recentPicksStr}

## Rules
- This is the **2026 NFL Draft**. The picks listed under "Available Draft Picks (current year)" are 2026 picks.
- When the user says "first round pick", "2026 first", "my 1st rounder", etc., they mean a CURRENT YEAR pick — find the matching pick by round from the "Available Draft Picks" lists and use its OVERALL number in "offeredPicks" or "requestedPicks".
- "offeredPicks" and "requestedPicks" use OVERALL pick numbers (not round.pick notation) — these are for current-year (2026) picks ONLY.
- "offeredFuturePicks" and "requestedFuturePicks" are for picks in FUTURE years (2027, 2028) ONLY — use format like "2027R1", "2028R3". NEVER put 2026 picks here. If a team has multiple picks in the same round (e.g. their own + one acquired via trade), append the original team abbreviation to disambiguate: "2027R5-CAR" means the 2027 5th-round pick that originally belonged to CAR. Without the suffix, the team's OWN pick is assumed.
- "offeredPlayers" and "requestedPlayers" use exact player names as shown in the rosters above
- "offered" means what the user's team GIVES UP
- "requested" means what the user's team RECEIVES
- "targetTeam" is the OTHER team's abbreviation (e.g. "DAL", "NYJ")
- If the user says "my 1st round pick" they mean their team's Round 1 pick from the picks listed above
- If the user says "their 2nd rounder" they mean the target team's Round 2 pick
- Match player names fuzzily — if they say "Mahomes" match to the full name "Patrick Mahomes" from the roster
- Match team names fuzzily — "Cowboys" = "DAL", "Niners" or "49ers" = "SF", etc.
- When the user references a player by position (e.g. "their QB"), look up the target team's roster to find the matching player
- This is a CONVERSATION. Previous messages may provide context. If the user says "yes", "do it", "sure", "that works", or similar, they are confirming a trade you previously suggested in the conversation. Build the trade proposal from your prior suggestion — fill in ALL the trade fields.
- Be PROACTIVE with suggestions. If the user says something vague like "swap late round picks with MIN", look at both teams' available picks in those rounds and propose a specific swap. Fill in the trade fields with your suggestion AND set "clarification" to describe what you're proposing so the user can confirm. For example: "How about your 6th (#206) for MIN's 7th (#218)? Reply 'yes' to send this proposal."
- If you cannot fully determine the trade but have a best guess, fill in the trade fields with your best guess AND set "clarification" to ask the user to confirm or clarify.
- Only set "error" if you truly cannot figure out any reasonable interpretation of the request.
- When asking for clarification without a specific suggestion, you MUST still set "targetTeam" if you know the team. Only leave trade fields empty when you genuinely don't have enough info to suggest anything.

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
  "clarification": null,
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
    await interaction.reply({ content: '❌ You need a registered team to propose trades. Use `/draft register` to claim one.', ephemeral: true });
    return;
  }

  const description = interaction.options.getString('description', true);
  await interaction.deferReply({ ephemeral: true });

  let systemPrompt = '';
  try {
    console.log(`[trade-ai] User=${interaction.user.tag} Team=${userTeam} Input="${description}"`);

    // ── Build fresh context snapshot ──

    // My team's picks
    const myPicks = manager.getFuturePicksForTeam(userTeam).map(s => ({
      overall: s.overall,
      round: s.round,
      roundPick: s.roundPick,
      originalTeam: s.originalTeam,
    }));

    // My team's current roster
    const myRoster = manager.searchRosterPlayers(userTeam, '');

    // My team's future pick rights
    const myFuturePicks = manager.getFuturePickRightsForTeam(userTeam).map(f => ({
      id: f.id,
      year: f.year,
      round: f.round,
      originalTeam: f.originalTeam,
    }));

    // Players my team has already drafted
    const myDraftedPlayers = manager.getTeamPicks(userTeam).map(p => ({
      prospectName: p.prospectName,
      pos: p.pos,
      overall: p.overall,
    }));

    // All other teams' picks and rosters
    const targetTeamPicks: Record<string, Array<{ overall: number; round: number; roundPick: number; originalTeam: string }>> = {};
    const targetTeamRosters: Record<string, Array<{ name: string; pos: string }>> = {};
    const targetTeamFuturePicks: Record<string, Array<{ year: number; round: number; originalTeam: string }>> = {};

    for (const abbr of Object.keys(TEAMS)) {
      if (abbr === userTeam) continue;
      targetTeamPicks[abbr] = manager.getFuturePicksForTeam(abbr).map(s => ({
        overall: s.overall,
        round: s.round,
        roundPick: s.roundPick,
        originalTeam: s.originalTeam,
      }));
      targetTeamRosters[abbr] = manager.searchRosterPlayers(abbr, '');
      targetTeamFuturePicks[abbr] = manager.getFuturePickRightsForTeam(abbr).map(f => ({
        year: f.year,
        round: f.round,
        originalTeam: f.originalTeam,
      }));
    }

    // Recent completed picks for draft context
    const completedPicks = state.picks.map(p => ({
      overall: p.overall,
      team: p.team,
      prospectName: p.prospectName,
      pos: p.pos,
    }));

    systemPrompt = buildTradeSystemPrompt(
      userTeam,
      TEAMS[userTeam]?.name ?? userTeam,
      myPicks,
      myRoster,
      myFuturePicks,
      myDraftedPlayers,
      targetTeamPicks,
      targetTeamRosters,
      targetTeamFuturePicks,
      completedPicks,
    );

    console.log(`[trade-ai] Prompt length: ${systemPrompt.length} chars, ~${Math.ceil(systemPrompt.length / 4)} tokens`);

    const history = conversations.get(interaction.user.id);
    const result = await chatJSONWithHistory<TradeAIResponse>(systemPrompt, history, description);
    console.log(`[trade-ai] LLM response: target=${result.targetTeam}, offeredPicks=${JSON.stringify(result.offeredPicks)}, requestedPicks=${JSON.stringify(result.requestedPicks)}, offeredPlayers=${JSON.stringify(result.offeredPlayers)}, requestedPlayers=${JSON.stringify(result.requestedPlayers)}, clarification=${result.clarification ?? 'none'}, error=${result.error ?? 'none'}`);

    // Save user input to history
    conversations.add(interaction.user.id, 'user', description);

    if (result.error) {
      const errorResponse = `❌ ${result.error}`;
      conversations.add(interaction.user.id, 'assistant', errorResponse);
      await interaction.editReply(errorResponse);
      return;
    }

    // Handle clarification — AI wants user to confirm or clarify before proposing
    if (result.clarification) {
      conversations.add(interaction.user.id, 'assistant', JSON.stringify(result));
      await interaction.editReply(`🤔 ${result.clarification}`);
      return;
    }

    // Validate target team
    if (!result.targetTeam || !TEAMS[result.targetTeam]) {
      const msg = `Couldn't determine which team. Try being more specific (e.g. "the Cowboys" or "DAL").`;
      conversations.add(interaction.user.id, 'assistant', msg);
      await interaction.editReply(`❌ ${msg}`);
      return;
    }

    // Find the receiver's userId (or route to CPU)
    const receiverUserId = state.assignments[result.targetTeam];
    const isCPUTarget = !receiverUserId;
    if (isCPUTarget && !manager.getConfig().cpuTrading) {
      const msg = `The **${TEAMS[result.targetTeam]?.name}** don't have a registered GM. No one to trade with.`;
      conversations.add(interaction.user.id, 'assistant', msg);
      await interaction.editReply(`❌ ${msg}`);
      return;
    }
    const receiverPings = receiverUserId ? (manager.getTeamPings(result.targetTeam) ?? `<@${receiverUserId}>`) : '';

    // Parse future picks into IDs (supports optional -TEAM suffix e.g. 2027R5-CAR)
    const parseFuturePickStr = (s: string, teamAbbr: string): string | null => {
      const m = s.match(/^(\d{4})[Rr](\d)(?:-([A-Z]{2,3}))?$/);
      if (!m) return null;
      const year = parseInt(m[1], 10);
      const round = parseInt(m[2], 10);
      const origTeam = m[3] || undefined;
      const right = manager.resolveFuturePickRight(teamAbbr, year, round, origTeam);
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

    // CPU team routing — AI GM evaluates immediately
    if (isCPUTarget) {
      const cpuTrade = {
        id: 'CPU-EVAL',
        proposerUserId: interaction.user.id,
        proposerTeam: userTeam,
        receiverUserId: 'cpu',
        receiverTeam: result.targetTeam,
        offeredOveralls: result.offeredPicks ?? [],
        requestedOveralls: result.requestedPicks ?? [],
        offeredPlayers: result.offeredPlayers ?? [],
        requestedPlayers: result.requestedPlayers ?? [],
        offeredFuturePicks: offeredFutureIds,
        requestedFuturePicks: requestedFutureIds,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };

      const evaluation = await manager.aiGM.evaluateHumanProposal(cpuTrade);
      if (!evaluation) {
        await interaction.editReply(summary + `\n\nThe **${targetTeamName}** GM is unavailable.`);
        return;
      }

      if (evaluation.decision === 'accept') {
        const execResult = await manager.trades.executeCPUTrade(cpuTrade);
        if (execResult.success) {
          conversations.clear(interaction.user.id);
          await interaction.editReply(summary + `\n\nThe **${targetTeamName}** GM accepted! *"${evaluation.reasoning}"*`);
        } else {
          await interaction.editReply(summary + `\n\nThe GM wanted to accept, but: ${execResult.error}`);
        }
      } else if (evaluation.decision === 'counter' && evaluation.counterOffer) {
        const co = evaluation.counterOffer;
        const fmtPicks = (p: number[]) => p.length ? `picks #${p.join(', #')}` : '';
        const fmtFut = (f: string[]) => f.length ? `future ${f.join(', ')}` : '';
        const coOffer = [fmtPicks(co.offeredOveralls), fmtFut(co.offeredFuturePicks)].filter(Boolean).join(' + ') || 'nothing';
        const coReq = [fmtPicks(co.requestedOveralls), fmtFut(co.requestedFuturePicks)].filter(Boolean).join(' + ') || 'nothing';
        conversations.add(interaction.user.id, 'assistant', `Counter from ${targetTeamName}: they send ${coOffer}, want ${coReq}`);
        await interaction.editReply(
          summary + `\n\nThe **${targetTeamName}** GM countered!\n*"${evaluation.reasoning}"*\n` +
          `**Counter:** They send ${coOffer}, they want ${coReq}`
        );
      } else {
        conversations.add(interaction.user.id, 'assistant', `${targetTeamName} declined: ${evaluation.reasoning}`);
        await interaction.editReply(summary + `\n\nThe **${targetTeamName}** GM declined. *"${evaluation.reasoning}"*`);
      }
      return;
    }

    // Actually propose the trade (human target)
    const tradeResult = await manager.trades.proposeTrade(
      interaction.user.id,
      receiverUserId!,
      result.offeredPicks ?? [],
      result.requestedPicks ?? [],
      result.offeredPlayers ?? [],
      result.requestedPlayers ?? [],
      offeredFutureIds,
      requestedFutureIds,
    );

    if (!tradeResult.success) {
      const failMsg = `Trade proposal failed: ${tradeResult.error}`;
      conversations.add(interaction.user.id, 'assistant', failMsg);
      await interaction.followUp({
        content: `❌ ${failMsg}`,
        ephemeral: true,
      });
      return;
    }

    const trade = tradeResult.trade!;

    // Show cap impact if relevant
    let capText = '';
    if (Object.keys(TEAM_CAP).length > 0) {
      const impact = manager.trades.calculateTradeCapImpact(trade);
      const fmtDelta = (d: number) => d >= 0 ? `+$${formatCapAmount(d)}` : `-$${formatCapAmount(Math.abs(d))}`;
      capText = `\n**Cap Impact:**\n` +
        `${myTeamName}: ${fmtDelta(impact.proposerCapChange)} (eff. space: $${formatCapAmount(impact.proposerNewSpace)})\n` +
        `${targetTeamName}: ${fmtDelta(impact.receiverCapChange)} (eff. space: $${formatCapAmount(impact.receiverNewSpace)})`;

      const capCheck = manager.trades.validateTradeCap(trade);
      if (capCheck.warnings.length > 0) {
        capText += `\n⚠️ ${capCheck.warnings.join('\n⚠️ ')}`;
      }
    }

    // Ephemeral confirmation to the proposer
    const hasPicks = (result.offeredPicks?.length ?? 0) > 0 || (result.requestedPicks?.length ?? 0) > 0 ||
      (result.offeredFuturePicks?.length ?? 0) > 0 || (result.requestedFuturePicks?.length ?? 0) > 0;
    const chartLink = hasPicks ? `\n[Trade chart](${buildTradeChartUrl(trade, state.schedule)})` : '';
    const clarifyNote = result.clarification ? `\n> ℹ️ ${result.clarification}\n` : '';

    await interaction.editReply(
      `✅ Trade proposal **[${trade.id}]** sent!\n` +
      `**${myTeamName}** send: ${formatSide(result.offeredPicks ?? [], result.offeredPlayers ?? [], result.offeredFuturePicks ?? [])}\n` +
      `**${targetTeamName}** send: ${formatSide(result.requestedPicks ?? [], result.requestedPlayers ?? [], result.requestedFuturePicks ?? [])}` +
      clarifyNote + capText + chartLink + `\n\n` +
      `${receiverPings} — use \`/trade accept ${trade.id}\` to accept, or \`/trade decline ${trade.id}\` to decline.`
    );

    // Clear conversation history after a successful proposal
    conversations.clear(interaction.user.id);

    // Public announcement based on draft settings
    const announcement = manager.getConfig().tradeAnnouncement;
    if (announcement === 'public') {
      await interaction.followUp({
        content: receiverPings,
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🔄 Trade Proposed')
            .setDescription(
              `**${myTeamName}** send: ${formatSide(result.offeredPicks ?? [], result.offeredPlayers ?? [], result.offeredFuturePicks ?? [])}\n` +
              `**${targetTeamName}** send: ${formatSide(result.requestedPicks ?? [], result.requestedPlayers ?? [], result.requestedFuturePicks ?? [])}`
            )
        ]
      });
    } else if (announcement === 'intrigue') {
      await interaction.followUp({
        content: receiverPings,
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('📞 Incoming Trade Offer!')
            .setDescription(`**${manager.getTeamGMLabel(result.targetTeam)}** has received a trade proposal. Check \`/trade list\` for details.`)
        ]
      });
    } else if (announcement === 'insider') {
      const insiderEmbed = await buildInsiderTradeEmbed(targetTeamName);
      await interaction.followUp({
        content: receiverPings,
        embeds: [insiderEmbed],
      });
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      await interaction.editReply('❌ Could not connect to Ollama. Make sure the Ollama server is running and `OLLAMA_HOST` is correct.');
    } else {
      const truncMsg = message.slice(0, 1800);
      await interaction.editReply(`❌ AI error: ${truncMsg}`);
      console.error('[trade-ai] Error:', message);
      console.error('[trade-ai] System prompt sent:', systemPrompt.slice(0, 2000), '...');
    }
  }
}
