import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import { DraftManager } from '../draft/DraftManager';
import { TEAMS } from '../data/teams';
import { ALL_POSITIONS } from '../data/prospects';
import { isOllamaConfigured, chatJSON } from '../llm/OllamaService';
import { buildMyBoardEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('board-ai')
  .setDescription('Describe draft board changes in plain English and let the AI apply them')
  .addStringOption(opt => opt
    .setName('description')
    .setDescription('e.g. "prioritize QBs and edge rushers" or "move Cam Ward to the top of my board"')
    .setRequired(true)
  );

interface BoardAIResponse {
  action: 'submit_board' | 'set_priority' | 'clear';
  board?: string[];
  priority?: string[];
  clearWhat?: 'board' | 'priority' | 'all';
  explanation: string;
  error?: string;
}

/**
 * Build a full context snapshot for the LLM board agent.
 * Stateless agent — everything it needs is in this prompt.
 */
function buildBoardSystemPrompt(
  teamAbbr: string,
  teamName: string,
  availableProspects: Array<{ rank: number; name: string; pos: string; school: string }>,
  currentBoard: Array<{ rank: number; name: string; pos: string }>,
  currentPriority: string[],
  currentRoster: Array<{ name: string; pos: string }>,
  draftedPlayers: Array<{ prospectName: string; pos: string; overall: number }>,
  remainingPicks: number,
  strategyNotes: string[],
): string {
  const defaultBoardSize = Math.max(10, remainingPicks * 2);
  const prospectsStr = availableProspects
    .map(p => `  ${p.rank}. ${p.name} (${p.pos}, ${p.school})`)
    .join('\n');

  const boardStr = currentBoard.length > 0
    ? currentBoard.map((p, i) => `  ${i + 1}. ${p.name} (${p.pos})`).join('\n')
    : '  (no custom board set)';

  const priorityStr = currentPriority.length > 0
    ? currentPriority.join(' → ')
    : '(none set)';

  const rosterStr = currentRoster.length > 0
    ? currentRoster.map(p => `  ${p.name} (${p.pos})`).join('\n')
    : '  (none loaded)';

  const draftedStr = draftedPlayers.length > 0
    ? draftedPlayers.map(p => `  #${p.overall}: ${p.prospectName} (${p.pos})`).join('\n')
    : '  (none yet)';

  const positionsList = ALL_POSITIONS.join(', ');

  return `You are an NFL draft board assistant for a mock draft Discord bot. Your job is to parse natural-language instructions about draft board changes into structured data.

You are a stateless agent — all the information you need is in this prompt.

The user controls the **${teamName} (${teamAbbr})**.

## Current Roster
These are the players already on the team's NFL roster (before the draft):
${rosterStr}

## Players Already Drafted This Session
These picks have already been made for this team in the current draft:
${draftedStr}

## Available Prospects (by overall rank)
These are the prospects still available to be drafted:
${prospectsStr}

## Current Custom Board
This is the team's current custom draft board (autopick order):
${boardStr}

## Current Position Priority
${priorityStr}

## Valid Positions
${positionsList}
${strategyNotes.length > 0 ? `
## Recent GM Instructions (memory)
These are the GM's recent board-ai requests, oldest first. Use them as context for their draft strategy — the current request takes priority over these.
${strategyNotes.map((n, i) => `  ${i + 1}. "${n}"`).join('\n')}
` : ''}
## Actions You Can Take

### 1. submit_board
Set a custom draft board — an ordered list of prospect NAMES. When autopick fires, it picks the highest-ranked available player on this board.
- The board should contain player names EXACTLY as they appear in the "Available Prospects" list above. Return ONLY the name (e.g. "Caleb Downs"), NOT the position or school (e.g. NOT "Caleb Downs (S, Ohio State)").
- The team has **${remainingPicks} picks remaining** in this draft. By default, return a board of about **${defaultBoardSize} players** — enough to cover their picks with some buffer. Only return more if the user explicitly asks for a longer board.
- If the user wants to reorder, add, or remove players, return the full updated board.
- If the user says "prioritize WRs" without other context and they have no board, create a board that puts WR prospects first, then other positions by rank.
- When the user says "draft for need" or "fill roster holes", look at their current roster and drafted players to identify weak positions, then build a board that prioritizes those positions.

### 2. set_priority
Set a position priority list for autopick fallback. This is used when the custom board runs out.
- Return an array of position abbreviations in priority order.
- Example: ["QB", "OT", "EDGE", "CB"]
- When the user asks to "draft for need", analyze the roster to determine which positions need reinforcement.

### 3. clear
Clear the custom board, position priority, or both.
- Set "clearWhat" to "board", "priority", or "all".

## Rules
- Match player names fuzzily — "Cam Ward" matches "Cam Ward" in the list, "Travis Hunter" matches "Travis Hunter"
- If a player name is ambiguous, pick the one that best matches context
- When the user says "move X to the top", put that player first on the board and keep the rest in order
- When the user says "remove X", return the board without that player
- If the user says "add X after Y", insert X right after Y in the board
- For "prioritize [position]" with no existing board: create a new board with those position players first, then fill with best available
- If you cannot determine the intent, set "error" to a helpful message

## Response Format
Respond with ONLY valid JSON in this exact format:
{
  "action": "submit_board" | "set_priority" | "clear",
  "board": ["Player Name 1", "Player Name 2", ...],
  "priority": ["QB", "OT", "EDGE"],
  "clearWhat": "board" | "priority" | "all",
  "explanation": "Brief explanation of changes made",
  "error": null
}

Only include the fields relevant to the action:
- "submit_board": include "board"
- "set_priority": include "priority"
- "clear": include "clearWhat"`;
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

  const userTeam = manager.getUserTeam(interaction.user.id);
  if (!userTeam) {
    await interaction.reply({ content: '❌ You need a registered team to edit your board.', ephemeral: true });
    return;
  }

  const description = interaction.options.getString('description', true);
  await interaction.deferReply({ ephemeral: true });

  let systemPrompt = '';
  try {
    console.log(`[board-ai] User=${interaction.user.tag} Team=${userTeam} Input="${description}"`);

    // ── Build fresh context snapshot ──

    // All available prospects (full list for the board)
    const { prospects: availableProspects } = manager.getAvailableProspects(undefined, 1, 500);
    const prospectData = availableProspects.map(p => ({
      rank: p.rank,
      name: p.name,
      pos: p.pos,
      school: p.school,
    }));

    // Current custom board
    const boardRanks = manager.getCustomBoard(userTeam);
    const currentBoard = boardRanks.map(rank => {
      const prospect = availableProspects.find(p => p.rank === rank);
      return prospect
        ? { rank, name: prospect.name, pos: prospect.pos }
        : { rank, name: `#${rank}`, pos: '?' };
    });

    // Current position priority
    const currentPriority = manager.getPositionPriority(userTeam);

    // Current NFL roster (so LLM can identify needs)
    const currentRoster = manager.searchRosterPlayers(userTeam, '');

    // Players already drafted this session
    const draftedPlayers = manager.getTeamPicks(userTeam).map(p => ({
      prospectName: p.prospectName,
      pos: p.pos,
      overall: p.overall,
    }));

    const remainingPicks = manager.getFuturePicksForTeam(userTeam).length;
    const strategyNotes = manager.getStrategyNotes(userTeam);

    systemPrompt = buildBoardSystemPrompt(
      userTeam,
      TEAMS[userTeam]?.name ?? userTeam,
      prospectData,
      currentBoard,
      currentPriority,
      currentRoster,
      draftedPlayers,
      remainingPicks,
      strategyNotes,
    );

    // Save this input as a strategy note for future context
    manager.addStrategyNote(userTeam, description, 10);

    console.log(`[board-ai] Prompt length: ${systemPrompt.length} chars, ~${Math.ceil(systemPrompt.length / 4)} tokens`);

    const result = await chatJSON<BoardAIResponse>(systemPrompt, description);
    console.log(`[board-ai] LLM response: action=${result.action}, board=${result.board?.length ?? 0} names, error=${result.error ?? 'none'}`);

    if (result.error) {
      await interaction.editReply(`❌ AI couldn't parse your request: ${result.error}`);
      return;
    }

    const teamName = TEAMS[userTeam]?.name ?? userTeam;

    if (result.action === 'submit_board') {
      const names = result.board ?? [];
      if (names.length === 0) {
        await interaction.editReply('❌ AI returned an empty board. Try rephrasing your request.');
        return;
      }

      const { matched, unmatched } = manager.submitBoard(userTeam, names);
      console.log(`[board-ai] submitBoard: matched=${matched}, unmatched=${unmatched.length}${unmatched.length > 0 ? ' [' + unmatched.join(', ') + ']' : ''}`);

      let reply = `✅ **AI Board Update for ${teamName}**\n`;
      reply += `> ${result.explanation}\n\n`;
      reply += `Matched **${matched}** prospect${matched !== 1 ? 's' : ''} to your board.`;

      if (unmatched.length > 0) {
        const shown = unmatched.slice(0, 8).map(n => `• ${n}`).join('\n');
        const extra = unmatched.length > 8 ? `\n_…and ${unmatched.length - 8} more_` : '';
        reply += `\n\n**${unmatched.length} unrecognized name${unmatched.length !== 1 ? 's' : ''} (skipped):**\n${shown}${extra}`;
      }

      // Show the board inline
      const { entries, total, totalPages, page } = manager.getMyBoardPage(userTeam, 1);
      const priority = manager.getPositionPriority(userTeam);
      const embed = buildMyBoardEmbed(teamName, entries, page, totalPages, total, priority);

      await interaction.editReply({ content: reply, embeds: [embed] });
      return;
    }

    if (result.action === 'set_priority') {
      const positions = result.priority ?? [];
      if (positions.length === 0) {
        await interaction.editReply('❌ AI returned an empty priority list. Try rephrasing.');
        return;
      }

      const invalid = positions.filter(p => !ALL_POSITIONS.includes(p.toUpperCase()));
      if (invalid.length > 0) {
        await interaction.editReply(`❌ AI suggested invalid position${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}. Try rephrasing.`);
        return;
      }

      const normalized = positions.map(p => p.toUpperCase());
      manager.setPositionPriority(userTeam, normalized);

      await interaction.editReply(
        `✅ **AI Position Priority for ${teamName}**\n` +
        `> ${result.explanation}\n\n` +
        `Priority: ${normalized.join(' → ')}\n` +
        `If your custom board runs out, autopick will target these positions in order.`
      );
      return;
    }

    if (result.action === 'clear') {
      const what = result.clearWhat ?? 'all';
      manager.clearBoard(userTeam, what);
      const label = what === 'board' ? 'custom board' : what === 'priority' ? 'position priority' : 'custom board and position priority';

      await interaction.editReply(
        `✅ **Cleared ${label} for ${teamName}**\n` +
        `> ${result.explanation}\n\n` +
        `Autopick will use default rank order.`
      );
      return;
    }

    await interaction.editReply(`❌ AI returned an unrecognized action: "${result.action}". Try rephrasing.`);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      await interaction.editReply('❌ Could not connect to Ollama. Make sure the Ollama server is running and `OLLAMA_HOST` is correct.');
    } else {
      const truncMsg = message.slice(0, 1800);
      await interaction.editReply(`❌ AI error: ${truncMsg}`);
      // Log full prompt for debugging
      console.error('[board-ai] Error:', message);
      console.error('[board-ai] System prompt sent:', systemPrompt.slice(0, 2000), '...');
    }
  }
}
