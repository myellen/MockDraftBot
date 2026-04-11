import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { DraftManager } from '../draft/DraftManager';
import { TEAMS } from '../data/teams';
import { ALL_POSITIONS } from '../data/prospects';
import { isOllamaConfigured, chatJSONWithHistory } from '../llm/OllamaService';
import { buildMyBoardEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('board-ai')
  .setDescription('Ask about prospects or manage your draft board with AI')
  .addStringOption(opt => opt
    .setName('description')
    .setDescription('e.g. "who are the best EDGE rushers?" or "prioritize QBs" or "put those on my board"')
    .setRequired(true)
  )
  .addAttachmentOption(opt => opt
    .setName('file')
    .setDescription('Optional .txt or .csv file with player names / board data for the AI to process')
    .setRequired(false)
  );

interface BoardAIResponse {
  action: 'submit_board' | 'set_priority' | 'clear' | 'answer_question';
  board?: string[];
  priority?: string[];
  clearWhat?: 'board' | 'priority' | 'all';
  answer?: string;
  explanation: string;
  error?: string;
}

// ── In-memory conversation history per user (resets on restart) ──
interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
}
const MAX_HISTORY = 6; // keep last 3 exchanges
const conversations = new Map<string, ConversationEntry[]>();

function getHistory(userId: string): ConversationEntry[] {
  return conversations.get(userId) ?? [];
}

function addToHistory(userId: string, role: 'user' | 'assistant', content: string): void {
  const history = conversations.get(userId) ?? [];
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  conversations.set(userId, history);
}

function clearHistory(userId: string): void {
  conversations.delete(userId);
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

  return `You are an NFL draft scout and board assistant for a mock draft Discord bot. You can answer questions about prospects, team needs, and draft strategy, AND parse board change instructions into structured data.

All the information you need is in this prompt and the conversation history.

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
- CRITICAL: The board array must contain ONLY bare player names. NEVER include position, school, or parenthetical info.
  ✅ CORRECT: "Caleb Downs"
  ❌ WRONG: "Caleb Downs (S, Ohio State)"
  ❌ WRONG: "Caleb Downs (S)"
  ❌ WRONG: "Caleb Downs, S"
- Names must match EXACTLY as they appear in the "Available Prospects" list above.
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

### 4. answer_question
Answer a question about prospects, team needs, draft strategy, or player comparisons.
- Use the "answer" field for your response (plain text, Discord-formatted markdown is OK).
- Be specific — cite prospect names, ranks, positions, and schools from the data above.
- Keep answers concise (under 1500 characters) — users are in Discord, not reading essays.
- If the user seems to be asking a question AND implying a board change, answer the question and note they can follow up to apply changes.

## Rules
- This is a CONVERSATION. Previous messages provide context. If the user says "put those on my board", "yes do it", or similar, they are referring to prospects from your previous answer — build a board from those players.
- When a user asks a question (who, what, which, compare, tell me about, how, why, etc.) use answer_question. When they give an instruction (prioritize, move, add, draft for need, set, put, build, create, etc.) use the appropriate board action.
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
  "action": "submit_board" | "set_priority" | "clear" | "answer_question",
  "board": ["Player Name 1", "Player Name 2", ...],
  "priority": ["QB", "OT", "EDGE"],
  "clearWhat": "board" | "priority" | "all",
  "answer": "Your detailed answer to the user's question",
  "explanation": "Brief explanation of changes made",
  "error": null
}

Only include the fields relevant to the action:
- "submit_board": include "board" and "explanation"
- "set_priority": include "priority" and "explanation"
- "clear": include "clearWhat" and "explanation"
- "answer_question": include "answer"`;
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
    await interaction.reply({ content: '❌ You need a registered team to edit your board. Use `/draft register` to claim one.', ephemeral: true });
    return;
  }

  const description = interaction.options.getString('description', true);
  const attachment = interaction.options.getAttachment('file');
  await interaction.deferReply({ ephemeral: true });

  // Fetch file content if provided
  let fileContent = '';
  if (attachment) {
    if (!attachment.contentType?.startsWith('text') && !attachment.name?.match(/\.(txt|csv)$/i)) {
      await interaction.editReply('❌ Please upload a `.txt` or `.csv` file.');
      return;
    }
    if (attachment.size > 200_000) {
      await interaction.editReply('❌ File too large (max 200 KB).');
      return;
    }
    try {
      const res = await fetch(attachment.url);
      fileContent = await res.text();
    } catch {
      await interaction.editReply('❌ Failed to download the file. Please try again.');
      return;
    }
  }

  let systemPrompt = '';
  try {
    const userMessage = fileContent
      ? `${description}\n\nFile content:\n${fileContent}`
      : description;
    console.log(`[board-ai] User=${interaction.user.tag} Team=${userTeam} Input="${description}"${fileContent ? ` File=${attachment!.name} (${fileContent.length} chars)` : ''}`);

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

    let result: BoardAIResponse;
    const history = getHistory(interaction.user.id);
    try {
      result = await chatJSONWithHistory<BoardAIResponse>(systemPrompt, history, userMessage);
    } catch (parseErr) {
      // Attempt to recover truncated JSON — extract board names from partial response
      const raw = parseErr instanceof Error ? parseErr.message : String(parseErr);
      const boardMatch = raw.match(/"board"\s*:\s*\[([\s\S]*)/);
      if (boardMatch) {
        const names = [...boardMatch[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
        if (names.length > 0) {
          console.log(`[board-ai] Recovered ${names.length} names from truncated JSON`);
          result = { action: 'submit_board', board: names, explanation: 'Recovered from truncated response' };
        } else {
          throw parseErr;
        }
      } else {
        throw parseErr;
      }
    }

    // Strip position/school annotations the model sometimes adds (e.g. "Name (QB)" → "Name")
    if (result.board) {
      result.board = result.board.map(name => name.replace(/\s*\(.*\)\s*$/, '').replace(/,\s*[A-Z]{1,4}\s*$/, '').trim());
    }

    console.log(`[board-ai] LLM response: action=${result.action}, board=${result.board?.length ?? 0} names, error=${result.error ?? 'none'}`);

    if (result.error) {
      await interaction.editReply(`❌ AI couldn't parse your request: ${result.error}`);
      return;
    }

    const teamName = TEAMS[userTeam]?.name ?? userTeam;

    if (result.action === 'answer_question') {
      const answer = result.answer ?? result.explanation ?? 'No answer provided.';
      const truncated = answer.length > 4000 ? answer.slice(0, 3997) + '...' : answer;

      // Save to history for follow-up
      addToHistory(interaction.user.id, 'user', userMessage);
      addToHistory(interaction.user.id, 'assistant', JSON.stringify(result));

      const embed = new EmbedBuilder()
        .setColor(TEAMS[userTeam]?.color ?? 0x5865F2)
        .setTitle('Scout Report')
        .setDescription(truncated)
        .setFooter({ text: 'Follow up with /board-ai to ask more or apply changes to your board.' });

      await interaction.editReply({ embeds: [embed] });
      return;
    }

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

      clearHistory(interaction.user.id);
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

      clearHistory(interaction.user.id);
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

      clearHistory(interaction.user.id);
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
