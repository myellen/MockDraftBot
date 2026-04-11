import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import { DraftManager } from '../draft/DraftManager';
import { TEAMS } from '../data/teams';
import { ALL_POSITIONS } from '../data/prospects';
import { isOllamaConfigured, chatJSON } from '../llm/OllamaService';
import { buildMyBoardEmbed } from '../utils/embeds';
import { scoreAllProspects, countPositions, ScoredProspect } from '../draft/DraftScorer';
import { TeamNeeds } from '../draft/types';

export const data = new SlashCommandBuilder()
  .setName('board-ai')
  .setDescription('Describe draft board changes in plain English and let the AI apply them')
  .addStringOption(opt => opt
    .setName('description')
    .setDescription('e.g. "prioritize QBs and edge rushers" or "move Cam Ward to the top of my board"')
    .setRequired(true)
  )
  .addAttachmentOption(opt => opt
    .setName('file')
    .setDescription('Optional .txt or .csv file with player names / board data for the AI to process')
    .setRequired(false)
  );

interface BoardAIResponse {
  action: 'submit_board' | 'set_priority' | 'set_needs' | 'clear';
  board?: string[];
  priority?: string[];
  needs?: { primary?: string[]; secondary?: string[]; depth?: string[] };
  alsoSetNeeds?: { primary?: string[]; secondary?: string[]; depth?: string[] };
  clearWhat?: 'board' | 'priority' | 'needs' | 'all';
  explanation: string;
  error?: string;
}

// ── Analyst Agent types ─────────────────────────────────────────────────────

interface AnalystReport {
  topProspects: Array<{
    name: string;
    pos: string;
    rank: number;
    compositeScore: number;
    factors: string; // "Board:0.85 × PosVal:1.00 × Need:1.50 × Scarcity:1.00"
  }>;
  positionSummary: Array<{
    position: string;
    availableCount: number;
    topProspectName: string;
    scarcityLevel: 'abundant' | 'normal' | 'scarce' | 'critical';
  }>;
  currentNeeds: {
    primary: string[];
    secondary: string[];
    depth: string[];
    source: 'declared' | 'auto-detected';
  };
  warnings: string[];
  pickPressure: 'low' | 'medium' | 'high';
}

// ── Analyst Agent ───────────────────────────────────────────────────────────

const ANALYST_SYSTEM_PROMPT = `You are an NFL draft analytics engine. You receive pre-computed scoring data from a composite draft model and your job is to produce a concise structured analysis of a team's draft situation.

You are completely objective — you do NOT receive the GM's instructions. You analyze the numbers.

## Response Format
Respond with ONLY valid JSON matching this structure:
{
  "topProspects": [
    { "name": "Player Name", "pos": "POS", "rank": 1, "compositeScore": 0.85, "factors": "Board:0.85 × PosVal:1.00 × Need:1.50 × Scarcity:1.00" }
  ],
  "positionSummary": [
    { "position": "EDGE", "availableCount": 12, "topProspectName": "Player Name", "scarcityLevel": "normal" }
  ],
  "currentNeeds": { "primary": ["EDGE"], "secondary": ["CB"], "depth": ["OG"], "source": "declared" },
  "warnings": ["Only 2 EDGEs remain in the pool — take one now or miss out"],
  "pickPressure": "medium"
}

## Rules
- "topProspects": Return the top 10 prospects from the scoring data, preserving the composite score order
- "positionSummary": Group all available prospects by position. Set scarcityLevel based on available count: critical (0-2), scarce (3-5), normal (6-15), abundant (16+)
- "warnings": Flag any position with critical or scarce availability that overlaps with the team's needs. Also warn if the team has 0 picks at a position with primary need. Max 4 warnings.
- "pickPressure": Based on remaining picks vs unfilled needs — "high" if needs > remaining picks, "medium" if roughly equal, "low" if plenty of picks
- "currentNeeds.source": "declared" if the needs were set by the GM, "auto-detected" if inferred from roster depth`;

/**
 * Build the data payload for the analyst agent from pre-computed scoring results.
 */
function buildAnalystInput(
  teamAbbr: string,
  scored: ScoredProspect[],
  positionCounts: Record<string, number>,
  needs: TeamNeeds,
  needsSource: 'declared' | 'auto-detected',
  remainingPickCount: number,
  draftedPositions: string[],
): string {
  // Top 30 scored prospects with factor breakdowns
  const top30 = scored.slice(0, 30).map(sp => {
    const p = sp.prospect;
    return `  #${p.rank} ${p.name} (${p.pos}) — Composite: ${sp.compositeScore.toFixed(4)} [Board:${sp.boardScore.toFixed(3)} × PosVal:${sp.positionalValue.toFixed(3)} × Need:${sp.needUrgency.toFixed(3)} × Scarcity:${sp.scarcityPremium.toFixed(3)}]`;
  }).join('\n');

  // Position availability counts
  const posCounts: Record<string, number> = {};
  for (const sp of scored) {
    posCounts[sp.prospect.pos] = (posCounts[sp.prospect.pos] ?? 0) + 1;
  }
  const posAvail = Object.entries(posCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([pos, count]) => `  ${pos}: ${count} available`)
    .join('\n');

  // Roster depth
  const rosterDepth = Object.entries(positionCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([pos, count]) => `  ${pos}: ${count} on roster`)
    .join('\n');

  return `Team: ${teamAbbr} (${TEAMS[teamAbbr]?.name ?? teamAbbr})
Remaining picks: ${remainingPickCount}
Positions already drafted this session: ${draftedPositions.length > 0 ? draftedPositions.join(', ') : '(none)'}

## Current Needs (${needsSource})
Primary: ${needs.primary.length > 0 ? needs.primary.join(', ') : '(none)'}
Secondary: ${needs.secondary.length > 0 ? needs.secondary.join(', ') : '(none)'}
Depth: ${needs.depth.length > 0 ? needs.depth.join(', ') : '(none)'}

## Roster Depth by Position
${rosterDepth}

## Available Prospect Pool by Position
${posAvail}

## Top 30 Prospects by Composite Score
${top30}`;
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
  currentNeeds: TeamNeeds | undefined,
  currentRoster: Array<{ name: string; pos: string }>,
  draftedPlayers: Array<{ prospectName: string; pos: string; overall: number }>,
  remainingPicks: number,
  strategyNotes: string[],
  analystReport: AnalystReport | null,
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

  const needsStr = currentNeeds
    ? [
        currentNeeds.primary.length > 0 ? `  Primary: ${currentNeeds.primary.join(', ')}` : null,
        currentNeeds.secondary.length > 0 ? `  Secondary: ${currentNeeds.secondary.join(', ')}` : null,
        currentNeeds.depth.length > 0 ? `  Depth: ${currentNeeds.depth.join(', ')}` : null,
      ].filter(Boolean).join('\n') || '  (none set)'
    : '  (none set — auto-detected from roster)';

  const rosterStr = currentRoster.length > 0
    ? currentRoster.map(p => `  ${p.name} (${p.pos})`).join('\n')
    : '  (none loaded)';

  const draftedStr = draftedPlayers.length > 0
    ? draftedPlayers.map(p => `  #${p.overall}: ${p.prospectName} (${p.pos})`).join('\n')
    : '  (none yet)';

  const positionsList = ALL_POSITIONS.join(', ');

  // Build analyst section if available
  let analystSection = '';
  if (analystReport) {
    const topStr = analystReport.topProspects
      .map((p, i) => `  ${i + 1}. ${p.name} (${p.pos}, #${p.rank}) — Score: ${p.compositeScore.toFixed(4)} [${p.factors}]`)
      .join('\n');

    const warningsStr = analystReport.warnings.length > 0
      ? analystReport.warnings.map(w => `  ⚠️ ${w}`).join('\n')
      : '  (none)';

    const scarcityStr = analystReport.positionSummary
      .filter(ps => ps.scarcityLevel === 'critical' || ps.scarcityLevel === 'scarce')
      .map(ps => `  ${ps.position}: ${ps.availableCount} left (${ps.scarcityLevel}) — best: ${ps.topProspectName}`)
      .join('\n') || '  (no scarce positions)';

    analystSection = `
## Scoring Engine Analysis
The composite scoring engine has analyzed all available prospects. Use this analysis to make smarter board decisions — it accounts for board rank, positional value (diminishing returns), need urgency, and scarcity premium.

### Top Prospects by Composite Score
${topStr}

### Scarce Positions
${scarcityStr}

### Warnings
${warningsStr}

### Pick Pressure: ${analystReport.pickPressure.toUpperCase()}
`;
  }

  return `You are an NFL draft board assistant for a mock draft Discord bot. Your job is to parse natural-language instructions about draft board changes into structured data.

You are a stateless agent — all the information you need is in this prompt.

The user controls the **${teamName} (${teamAbbr})**.
${analystSection}
## Current Roster
These are the players already on the team's NFL roster (before the draft):
${rosterStr}

## Players Already Drafted This Session
These picks have already been made for this team in the current draft:
${draftedStr}

## Available Prospects (by composite score)
These are the top prospects still available, ranked by the scoring engine:
${prospectsStr}

## Current Custom Board
This is the team's current custom draft board (autopick order):
${boardStr}

## Current Position Priority
${priorityStr}

## Current Position Needs
${needsStr}

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
- When the user says "draft for need" or "fill roster holes", use the scoring engine analysis above — it already factors in positional need, scarcity, and diminishing returns.
- If the user's request implies they want to set needs too (e.g. "I need EDGE and CB, build a board"), also populate the "alsoSetNeeds" field.

### 2. set_priority
Set a position priority list for autopick fallback. This is used when the custom board runs out.
- Return an array of position abbreviations in priority order.
- Example: ["QB", "OT", "EDGE", "CB"]
- When the user asks to "draft for need", use the scoring engine analysis to determine which positions need reinforcement.

### 3. set_needs
Set the team's positional needs for the scoring engine. This directly affects how autopick ranks prospects.
- Return a "needs" object with "primary", "secondary", and "depth" arrays of position abbreviations.
- Primary needs get the strongest boost (1.5×), secondary moderate (1.2×), depth minor (1.0×).
- Use this when the user explicitly talks about team needs, holes, or positions they want to target.

### 4. clear
Clear the custom board, position priority, needs, or all.
- Set "clearWhat" to "board", "priority", "needs", or "all".

## Rules
- Match player names fuzzily — "Cam Ward" matches "Cam Ward" in the list, "Travis Hunter" matches "Travis Hunter"
- If a player name is ambiguous, pick the one that best matches context
- When the user says "move X to the top", put that player first on the board and keep the rest in order
- When the user says "remove X", return the board without that player
- If the user says "add X after Y", insert X right after Y in the board
- For "prioritize [position]" with no existing board: create a new board with those position players first, then fill with best available
- If the user's request involves both setting needs AND building a board, set "action" to "submit_board" and populate "alsoSetNeeds" with the needs — both will be applied
- If you cannot determine the intent, set "error" to a helpful message

## Response Format
Respond with ONLY valid JSON in this exact format:
{
  "action": "submit_board" | "set_priority" | "set_needs" | "clear",
  "board": ["Player Name 1", "Player Name 2", ...],
  "priority": ["QB", "OT", "EDGE"],
  "needs": { "primary": ["EDGE", "CB"], "secondary": ["WR"], "depth": ["OG"] },
  "alsoSetNeeds": { "primary": ["EDGE"], "secondary": ["WR"], "depth": [] },
  "clearWhat": "board" | "priority" | "needs" | "all",
  "explanation": "Brief explanation of changes made",
  "error": null
}

Only include the fields relevant to the action:
- "submit_board": include "board" (and optionally "alsoSetNeeds")
- "set_priority": include "priority"
- "set_needs": include "needs"
- "clear": include "clearWhat"`;
}

/**
 * Validate and normalize a needs object from AI response.
 * Returns null if invalid positions found.
 */
function validateNeeds(
  raw: { primary?: string[]; secondary?: string[]; depth?: string[] } | undefined,
): { needs: TeamNeeds; invalid: string[] } | null {
  if (!raw) return null;
  const allPos = [...(raw.primary ?? []), ...(raw.secondary ?? []), ...(raw.depth ?? [])];
  if (allPos.length === 0) return null;
  const invalid = allPos.filter(p => !ALL_POSITIONS.includes(p.toUpperCase()));
  const needs: TeamNeeds = {
    primary: (raw.primary ?? []).map(p => p.toUpperCase()),
    secondary: (raw.secondary ?? []).map(p => p.toUpperCase()),
    depth: (raw.depth ?? []).map(p => p.toUpperCase()),
  };
  return { needs, invalid };
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

  let boardPrompt = '';
  try {
    const userMessage = fileContent
      ? `${description}\n\nFile content:\n${fileContent}`
      : description;
    console.log(`[board-ai] User=${interaction.user.tag} Team=${userTeam} Input="${description}"${fileContent ? ` File=${attachment!.name} (${fileContent.length} chars)` : ''}`);

    // ── Gather context ──────────────────────────────────────────────────────

    const { prospects: allAvailable } = manager.getAvailableProspects(undefined, 1, 500);

    const boardRanks = manager.getCustomBoard(userTeam);
    const currentBoard = boardRanks.map(rank => {
      const prospect = allAvailable.find((p: { rank: number }) => p.rank === rank);
      return prospect
        ? { rank, name: prospect.name, pos: prospect.pos }
        : { rank, name: `#${rank}`, pos: '?' };
    });

    const currentPriority = manager.getPositionPriority(userTeam);
    const currentNeeds = manager.getTeamNeeds(userTeam);
    const currentRoster = manager.searchRosterPlayers(userTeam, '');
    const teamPicks = manager.getTeamPicks(userTeam);
    const draftedPlayers = teamPicks.map(p => ({
      prospectName: p.prospectName,
      pos: p.pos,
      overall: p.overall,
    }));
    const remainingPicks = manager.getFuturePicksForTeam(userTeam).length;
    const strategyNotes = manager.getStrategyNotes(userTeam);

    // Save instruction as a strategy note for future context
    manager.addStrategyNote(userTeam, description, 10);

    // ── Stage 1: Analyst Agent ──────────────────────────────────────────────
    // Runs the composite scoring engine and asks the LLM to summarize the
    // team's situation. Only runs if the draft is active (prospects available).

    let analystReport: AnalystReport | null = null;
    let scored: ScoredProspect[] = [];
    const draftActive = manager.getState().availableRanks.length > 0;

    if (draftActive) {
      await interaction.editReply('🔍 Analyzing your team situation...');

      const ctx = manager.buildScorerContext(userTeam);
      scored = scoreAllProspects(ctx);

      // Build position counts for the analyst
      const roster = (currentRoster ?? []).map(r => ({ name: r.name, pos: r.pos }));
      const posCounts = countPositions(roster, teamPicks);
      const needsSource = currentNeeds ? 'declared' as const : 'auto-detected' as const;
      const effectiveNeeds = ctx.needs;
      const draftedPositions = teamPicks.map(p => p.pos);

      const analystInput = buildAnalystInput(
        userTeam,
        scored,
        posCounts,
        effectiveNeeds,
        needsSource,
        remainingPicks,
        draftedPositions,
      );

      console.log(`[board-ai] Analyst input: ${analystInput.length} chars`);

      try {
        analystReport = await chatJSON<AnalystReport>(ANALYST_SYSTEM_PROMPT, analystInput);
        console.log(`[board-ai] Analyst: ${analystReport.topProspects.length} top prospects, ${analystReport.warnings.length} warnings, pressure=${analystReport.pickPressure}`);
      } catch (err) {
        // Analyst failure is non-fatal — fall back to board agent without analysis
        console.warn('[board-ai] Analyst agent failed, continuing without analysis:', err instanceof Error ? err.message : String(err));
      }
    }

    // ── Stage 2: Board Agent ────────────────────────────────────────────────
    // Takes the analyst's report + user instruction and produces the action.

    await interaction.editReply(draftActive
      ? '🏈 Building your board...'
      : '🏈 Processing your request...');

    // Use top 50 by composite score if scoring ran, otherwise full list
    const prospectPool: Array<{ rank: number; name: string; pos: string; school: string }> = scored.length > 0
      ? scored.slice(0, 50).map(sp => ({
          rank: sp.prospect.rank,
          name: sp.prospect.name,
          pos: sp.prospect.pos,
          school: sp.prospect.school,
        }))
      : allAvailable.map((p: { rank: number; name: string; pos: string; school: string }) => ({
          rank: p.rank, name: p.name, pos: p.pos, school: p.school,
        }));

    // If user mentions specific player names, ensure those are in the pool
    // even if they're outside the top 50
    if (scored.length > 50) {
      const poolRanks = new Set(prospectPool.map(p => p.rank));
      const descLower = description.toLowerCase();
      for (const sp of scored.slice(50)) {
        if (descLower.includes(sp.prospect.name.toLowerCase()) && !poolRanks.has(sp.prospect.rank)) {
          prospectPool.push({
            rank: sp.prospect.rank,
            name: sp.prospect.name,
            pos: sp.prospect.pos,
            school: sp.prospect.school,
          });
        }
      }
    }

    boardPrompt = buildBoardSystemPrompt(
      userTeam,
      TEAMS[userTeam]?.name ?? userTeam,
      prospectPool,
      currentBoard,
      currentPriority,
      currentNeeds,
      currentRoster,
      draftedPlayers,
      remainingPicks,
      strategyNotes,
      analystReport,
    );

    console.log(`[board-ai] Board prompt: ${boardPrompt.length} chars, ~${Math.ceil(boardPrompt.length / 4)} tokens`);

    let result: BoardAIResponse;
    try {
      result = await chatJSON<BoardAIResponse>(boardPrompt, userMessage);
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

    // ── Apply side-effect needs if present ───────────────────────────────────
    let needsSideEffect = '';
    if (result.alsoSetNeeds) {
      const validated = validateNeeds(result.alsoSetNeeds);
      if (validated && validated.invalid.length === 0) {
        manager.setTeamNeeds(userTeam, validated.needs);
        const parts: string[] = [];
        if (validated.needs.primary.length > 0) parts.push(`Primary: ${validated.needs.primary.join(', ')}`);
        if (validated.needs.secondary.length > 0) parts.push(`Secondary: ${validated.needs.secondary.join(', ')}`);
        if (validated.needs.depth.length > 0) parts.push(`Depth: ${validated.needs.depth.join(', ')}`);
        needsSideEffect = `\n📋 **Needs also updated:** ${parts.join(' | ')}`;
        console.log(`[board-ai] Side-effect needs set: ${JSON.stringify(validated.needs)}`);
      }
    }

    // ── Handle actions ──────────────────────────────────────────────────────

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

      reply += needsSideEffect;

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
        `If your custom board runs out, autopick will target these positions in order.` +
        needsSideEffect
      );
      return;
    }

    if (result.action === 'set_needs') {
      const validated = validateNeeds(result.needs);
      if (!validated || (validated.needs.primary.length === 0 && validated.needs.secondary.length === 0 && validated.needs.depth.length === 0)) {
        await interaction.editReply('❌ AI returned empty needs. Try rephrasing your request.');
        return;
      }

      if (validated.invalid.length > 0) {
        await interaction.editReply(`❌ AI suggested invalid position${validated.invalid.length > 1 ? 's' : ''}: ${validated.invalid.join(', ')}. Try rephrasing.`);
        return;
      }

      manager.setTeamNeeds(userTeam, validated.needs);

      const lines: string[] = [`✅ **AI Needs Update for ${teamName}**`];
      lines.push(`> ${result.explanation}\n`);
      if (validated.needs.primary.length > 0) lines.push(`🔴 **Primary:** ${validated.needs.primary.join(', ')}`);
      if (validated.needs.secondary.length > 0) lines.push(`🟡 **Secondary:** ${validated.needs.secondary.join(', ')}`);
      if (validated.needs.depth.length > 0) lines.push(`🟢 **Depth:** ${validated.needs.depth.join(', ')}`);
      lines.push('\nThe scoring engine will now prioritize these positions for autopick.');

      await interaction.editReply(lines.join('\n'));
      return;
    }

    if (result.action === 'clear') {
      const what = result.clearWhat ?? 'all';
      manager.clearBoard(userTeam, what as 'board' | 'priority' | 'needs' | 'all');
      const labels: Record<string, string> = {
        board: 'custom board',
        priority: 'position priority',
        needs: 'position needs',
        all: 'custom board, position priority, and needs',
      };

      await interaction.editReply(
        `✅ **Cleared ${labels[what] ?? what} for ${teamName}**\n` +
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
      console.error('[board-ai] Board prompt sent:', boardPrompt.slice(0, 2000), '...');
    }
  }
}
