import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import { DraftManager } from '../draft/DraftManager';
import { TEAMS } from '../data/teams';
import { ALL_POSITIONS } from '../data/prospects';
import { isOllamaConfigured, chatJSON, chatJSONWithHistory } from '../llm/OllamaService';
import { buildMyBoardEmbed } from '../utils/embeds';
import { isAdmin } from '../utils/permissions';
import { isAvailable as isBeastAvailable, lookupProspect, lookupProspectLight, lookupByPositionRank, searchByPosition, getTopProspects, getBeastRanking, queryProspects, ragSearch } from '../data/beastScouting';
import type { ProspectQuery } from '../data/beastScouting';

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
  )
  .addBooleanOption(opt => opt
    .setName('public')
    .setDescription('Show response publicly (admin only)')
    .setRequired(false)
  );

interface BoardAIResponse {
  action: 'submit_board' | 'set_strategy' | 'clear' | 'answer_question';
  board?: string[];
  strategyPrompt?: string;
  clearWhat?: 'board' | 'strategy' | 'all';
  answer?: string;
  explanation: string;
  error?: string;
}

// ── In-memory conversation history per user (resets on restart) ──
interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
}
const MAX_HISTORY = 10; // keep last 5 exchanges
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
  currentStrategy: string | undefined,
  currentRoster: Array<{ name: string; pos: string }>,
  draftedPlayers: Array<{ prospectName: string; pos: string; overall: number }>,
  remainingPicks: number,
  strategyNotes: string[],
): string {
  const defaultBoardSize = Math.max(10, remainingPicks * 2);
  // Compact format to minimize tokens: "1. Name|POS|School"
  const prospectsStr = availableProspects
    .map(p => `${p.rank}. ${p.name}|${p.pos}|${p.school}`)
    .join('\n');

  const boardStr = currentBoard.length > 0
    ? currentBoard.map((p, i) => `  ${i + 1}. ${p.name} (${p.pos})`).join('\n')
    : '  (no custom board set)';

  const strategyStr = currentStrategy
    ? currentStrategy
    : '(none set — use set_strategy to create one)';

  const rosterStr = currentRoster.length > 0
    ? currentRoster.map(p => `${p.name}|${p.pos}`).join(', ')
    : '(none loaded)';

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

## Available Prospects
These are the prospects still available to be drafted. The "#" is just a pool ID for name matching — it is NOT a quality ranking. Do NOT cite these numbers as prospect rankings.
${prospectsStr}

## Current Custom Board
This is the team's current custom draft board (autopick order):
${boardStr}

## Current Draft Strategy
${strategyStr}

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

### 2. set_strategy
Set a draft strategy prompt that guides autopick decisions. This is stored and used by the AI when making picks.
- Put the strategy text in the "strategyPrompt" field — write it as instructions to a draft AI (e.g. "Prioritize pass rushers and cornerbacks in the first two rounds. Value athletic upside over production. Avoid small-school QBs.")
- The strategy should be 2-6 sentences capturing the user's draft philosophy.
- Before committing a strategy, use answer_question to ask 2-3 follow-up questions to understand the user's preferences:
  - What positions do they want to target early vs late?
  - Do they value athleticism, production, or NFL-readiness more?
  - Are there any positions or player types to avoid?
  - Any specific round-by-round priorities?
- Only use set_strategy when you have enough information to write a comprehensive prompt. If the user's request is vague ("help me build a strategy"), start a conversation first.
- When the user asks to "draft for need", analyze the roster and drafted players to identify gaps, then write a strategy that addresses them.

### 3. clear
Clear the custom board, strategy, or both.
- Set "clearWhat" to "board", "strategy", or "all".

### 4. answer_question
Answer a question about prospects, team needs, draft strategy, or player comparisons.
- Use the "answer" field for your response (plain text, Discord-formatted markdown is OK).
- Be specific — cite prospect names, ranks, positions, and schools from the data above.
- Keep answers concise but thorough. You can use up to 3000 characters if the question warrants it (e.g. comparing 30 prospects). Don't pad short answers though.
- **Formatting:** Use Discord markdown (**bold**, *italic*, headers, bullets) for prose. Discord does NOT support markdown tables — for tabular/comparative data, use a code block (\`\`\`) with monospace-aligned columns. Only the table itself should be in the code block; all other text stays outside so markdown renders.
- **Tables:** Put ALL data in ONE code block table. NEVER use two separate tables or split data across tables. When the user asks for combine numbers, include ALL combine columns (40, Vert, Broad, Shuttle, 3Cone, Bench). When they also ask for grade or stats, add those as extra columns — do NOT drop combine columns to make room. Use short column headers to keep it compact (Grd, 40, Vrt, Brd, Sht, 3C, Bnc, Arm, Hnd, RecTD, RecYd). Example with combine + grade + stats:
\`\`\`
Player            | Grd     | 40   | Vrt  | Brd    | Sht  | 3C   | Bnc | Arm    | Hnd  | RecTD | RecYd
------------------|---------|------|------|--------|------|------|-----|--------|------|-------|------
Name Here         | 2nd Rd  | 4.46 | 35"  | 10'09" | 4.21 | 6.89 | 22  | 32 1/2 | 9 1/2| 11    | 1156
\`\`\`
  Show "---" for missing data. You may omit a column ONLY if every player has "---" for it.
- **Scouting highlights:** When results come from a trait/scouting search, ALWAYS include a "Scouting Highlights" section AFTER the table with bullet points explaining WHY each prospect matched the trait query. Cite Brugler's specific language (e.g. "noted for outstanding suddenness", "violent feet at the top of routes"). This is critical context that distinguishes a trait search from a simple stats query.
- If the user seems to be asking a question AND implying a board change, answer the question and note they can follow up to apply changes.
- **Scouting data from Dane Brugler's "The Beast" 2026 NFL Draft Guide may be appended to the user's message.** When present, ALWAYS prefer Beast data over the prospect pool list above. The Beast grades, position ranks (e.g. "EDGE5"), and overall ranks ("OVR #42") are authoritative — they come from the NFL's most respected draft analyst. The pool IDs in the "Available Prospects" list are NOT rankings. When citing a prospect's rank, use the Beast's position rank and overall rank, NOT the pool number.
- Reference specific Beast scouting insights: cite Brugler's grade (e.g. "2nd round grade"), strengths, weaknesses, and player comparisons.
- **Measurements:** Beast data includes labeled combine and pro day measurements (forty, vert, broad, shuttle, cone, bench, arm, hand, wing). Null values mean the prospect did not participate in that drill — show "---" in tables.

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
  "action": "submit_board" | "set_strategy" | "clear" | "answer_question",
  "board": ["Player Name 1", "Player Name 2", ...],
  "strategyPrompt": "Prioritize EDGE and CB in early rounds...",
  "clearWhat": "board" | "strategy" | "all",
  "answer": "Your detailed answer to the user's question",
  "explanation": "Brief explanation of changes made",
  "error": null
}

Only include the fields relevant to the action:
- "submit_board": include "board" and "explanation"
- "set_strategy": include "strategyPrompt" and "explanation"
- "clear": include "clearWhat" and "explanation"
- "answer_question": include "answer"`;
}

// ── LLM-powered scouting data extraction ──

interface DataNeeds {
  lookups: string[];                                  // prospect names to fetch full reports for
  posRanks: Array<{ pos: string; rank: number }>;     // "EDGE 30" ��� specific position rank lookup
  posLists: Array<{ pos: string; count: number }>;    // "top 30 EDGE" ��� list at position
  board: boolean;                                     // include scouting data for board players
  topN: number;                                       // >0 → include top N overall prospects
  query?: ProspectQuery | null;                       // flexible filter/sort/limit query
  ragQuery?: string | null;                           // qualitative scouting search ("high motor", "nose for the football")
}

const EXTRACTION_SYSTEM = `You extract NFL draft scouting data needs from a user query. Given the query, recent conversation context, and the user's board, determine what prospect data should be fetched from the scouting database.

Return ONLY JSON:
{
  "lookups": [],    // prospect names to get full scouting reports for (max 15)
  "posRanks": [],   // specific position rank lookups, e.g. [{"pos":"EDGE","rank":30}]
  "posLists": [],   // position group lists, e.g. [{"pos":"EDGE","count":30}]
  "board": false,   // true if query references "my board" or the user's draft strategy
  "topN": 0,        // >0 if query asks about best available / BPA / top overall prospects
  "query": null,    // structured query for filtering/sorting (see below), or null
  "ragQuery": null  // qualitative/trait-based scouting search string, or null
}

Key rules:
- "edge 30" / "EDGE30" / "the 30th edge" → posRanks: [{"pos":"EDGE","rank":30}] (specific prospect at that rank)
- "top 30 edge rushers" / "list 30 EDGE" → posLists: [{"pos":"EDGE","count":30}]
- "tell me about Cam Ward" → lookups: ["Cam Ward"]
- "tell me about him" / "what are his weaknesses" → resolve the pronoun from conversation context, put the actual name in lookups
- "compare X and Y" → lookups: ["X", "Y"]
- "best available" / "BPA" → topN: 20
- "draft for need" / "analyze my board" / "what should I draft" → board: true
- Position abbreviations: QB, RB, WR, TE, OT, G, C, EDGE, DT, LB, CB, S
- Default count for position lists is 10 unless user specifies
- If query is a simple board instruction ("prioritize QBs", "clear my board") with no scouting question, return all empty/false/0/null

Query object — for flexible filtering/sorting that the simple lookups above can't handle:
{
  "filters": [{"field": "...", "op": "...", "value": ...}],
  "sort": {"field": "...", "order": "asc" | "desc"},
  "limit": 20
}

Available fields:
- Top-level: pos, posRank, name, school, grade, ovrRank, age, ht (→ inches), wt (→ pounds)
- Combine: combine.forty, combine.vert (inches), combine.broad (inches), combine.shuttle, combine.cone, combine.bench, combine.hand (inches), combine.arm (inches), combine.wing (inches)
- Stats (most recent year): stats.sacks, stats.tackles, stats.tackles_for_loss, stats.passing_td, stats.passing_yards, stats.interceptions, stats.receptions, stats.receiving_yards, stats.receiving_td, stats.rushing_yards, stats.rushing_td, stats.carries

Operators: eq, neq, lt, gt, lte, gte, in, contains
- Heights must be in inches: 6'4" = 76, 6'2" = 74, 5'11" = 71
- Weights in pounds: 250, 200, etc.
- "in" takes an array: {"field":"pos","op":"in","value":["EDGE","DT"]}
- "contains" does substring match on strings/arrays (school, name, strengths, weaknesses)

When to use query vs other fields:
- "top 10 EDGEs" → posLists (simpler, more reliable)
- "EDGEs sorted by forty time" → query (needs sorting by measurement)
- "EDGEs under 250 lbs" → query (needs filtering by measurement)
- "fastest CBs" / "who ran the fastest 40" → query (sort by combine.forty asc)
- "tallest WRs" → query (sort by ht desc)
- "QBs who threw 30+ TDs" → query (filter stats.passing_td gt 30)
- "prospects from Ohio State" → query (filter school contains "Ohio State")
- "tell me about Travis Hunter" → lookups (specific prospect, NOT query)

Examples:
- "EDGEs under 250 with sub-4.5 40s sorted by forty" →
  query: {"filters":[{"field":"pos","op":"eq","value":"EDGE"},{"field":"wt","op":"lt","value":250},{"field":"combine.forty","op":"lt","value":4.5}],"sort":{"field":"combine.forty","order":"asc"},"limit":20}

- "who are the fastest cornerbacks?" →
  query: {"filters":[{"field":"pos","op":"eq","value":"CB"}],"sort":{"field":"combine.forty","order":"asc"},"limit":20}

- "tallest WRs in the draft" →
  query: {"filters":[{"field":"pos","op":"eq","value":"WR"}],"sort":{"field":"ht","order":"desc"},"limit":20}

- "QBs with over 30 passing TDs last year" →
  query: {"filters":[{"field":"pos","op":"eq","value":"QB"},{"field":"stats.passing_td","op":"gt","value":30}],"sort":{"field":"stats.passing_td","order":"desc"},"limit":20}

- "prospects from Ohio State sorted by overall rank" →
  query: {"filters":[{"field":"school","op":"contains","value":"Ohio State"}],"sort":{"field":"ovrRank","order":"asc"},"limit":30}

ragQuery — for qualitative/trait-based scouting searches:
- Use ragQuery when the user asks about player traits, skills, or scouting language that can't be expressed as numeric filters.
- "high motor" → ragQuery: "high motor"
- "good hands and route running" → ragQuery: "good hands route running"
- "explosive first step" → ragQuery: "explosive first step"
- "nose for the football" → ragQuery: "nose for the football"
- "guys who can cover" → ragQuery: "coverage skills man zone"
- ragQuery can coexist with other fields: "fast EDGEs with a high motor" → query (pos=EDGE, sort forty asc) + ragQuery ("high motor")
- Do NOT use ragQuery for measurable/numeric queries — those should use the query object
- Do NOT use ragQuery for specific player lookups — those should use lookups

Follow-up handling (CRITICAL):
- "what were their 40 times?" / "rank them by..." / "same but..." → look at conversation history to determine WHAT GROUP was discussed. If previous exchange was about "top 30 EDGE", re-fetch posLists: [{"pos":"EDGE","count":30}] with the SAME count. If the follow-up adds a filter or sort on top (e.g. "rank those by 40 time"), use a query instead.
- "same" / "same thing" / "do that again" → repeat the same data needs as implied by the previous exchange
- When the previous exchange discussed a position group, ALWAYS re-fetch that group via posLists — do NOT try to list individual names in lookups (the measurements data comes from the position list, not individual lookups)`;

/**
 * Use a fast LLM call to determine what scouting data the main call needs.
 * Falls back to empty data on failure (main LLM can still answer from its context).
 */
async function extractDataNeeds(
  description: string,
  userId: string,
  boardNames: string[],
): Promise<DataNeeds> {
  const fallback: DataNeeds = { lookups: [], posRanks: [], posLists: [], board: false, topN: 0 };

  try {
    // Build conversation context so extraction can resolve follow-ups
    const history = getHistory(userId);
    let contextBlock = '';
    if (history.length > 0) {
      // Include last 2 exchanges (user + assistant) so extraction sees the full thread
      const recent = history.slice(-4); // up to 2 user + 2 assistant entries
      const parts: string[] = [];
      for (const h of recent) {
        const label = h.role === 'user' ? 'User' : 'AI';
        // Generous truncation — extraction prompt is small, room for context
        parts.push(`${label}: ${h.content.slice(0, 1500)}`);
      }
      contextBlock = `\nConversation history:\n${parts.join('\n')}`;
    }
    const boardBlock = boardNames.length > 0
      ? `\nUser's board players: ${boardNames.slice(0, 20).join(', ')}`
      : '';

    const userMsg = `Query: ${description}${contextBlock}${boardBlock}`;
    console.log(`[board-ai] Extraction call: ${userMsg.length} chars`);

    const result = await chatJSON<DataNeeds>(EXTRACTION_SYSTEM, userMsg);
    console.log(`[board-ai] Extraction result: ${JSON.stringify(result)}`);

    return {
      lookups: Array.isArray(result.lookups) ? result.lookups.slice(0, 15) : [],
      posRanks: Array.isArray(result.posRanks) ? result.posRanks.slice(0, 5) : [],
      posLists: Array.isArray(result.posLists) ? result.posLists.slice(0, 3) : [],
      board: !!result.board,
      topN: typeof result.topN === 'number' ? Math.min(result.topN, 30) : 0,
      query: result.query && Array.isArray(result.query.filters) ? result.query : null,
      ragQuery: typeof result.ragQuery === 'string' && result.ragQuery.trim() ? result.ragQuery.trim() : null,
    };
  } catch (err) {
    console.warn('[board-ai] Extraction call failed, proceeding without pre-fetch:', err instanceof Error ? err.message : err);
    return fallback;
  }
}

/**
 * Fetch scouting data based on LLM-extracted data needs.
 */
async function fetchScoutingData(needs: DataNeeds, boardNames: string[]): Promise<string> {
  const sections: string[] = [];

  // 1. Named prospect lookups
  for (const name of needs.lookups) {
    const data = lookupProspect(name);
    if (!data.includes('"error"')) {
      sections.push(`### Scouting Report: ${name}\n${data}`);
    }
  }

  // 2. Position rank lookups (e.g. "EDGE 30" → the specific prospect)
  for (const { pos, rank } of needs.posRanks) {
    const data = lookupByPositionRank(pos, rank);
    if (!data.includes('"error"')) {
      sections.push(`### ${pos} #${rank} Scouting Report\n${data}`);
    }
  }

  // 3. Position group lists (e.g. "top 30 EDGE")
  for (const { pos, count } of needs.posLists) {
    const data = searchByPosition(pos, Math.min(count, 30));
    if (!data.includes('"error"')) {
      sections.push(`### Top ${count} ${pos} Prospects (Beast Rankings)\n${data}`);
    }
  }

  // 4. Board player lookups — use light version (measurements + stats, no writeup text)
  //    to fit all board players within token budget. Include board rank for ordering.
  if (needs.board && boardNames.length > 0) {
    const alreadyFetched = new Set(needs.lookups.map(n => n.toLowerCase()));
    const boardData: string[] = [];
    for (let i = 0; i < boardNames.length; i++) {
      const name = boardNames[i];
      if (alreadyFetched.has(name.toLowerCase())) continue;
      const data = lookupProspectLight(name);
      if (!data.includes('"error"')) {
        // Inject board rank so LLM knows the ordering
        const parsed = JSON.parse(data);
        parsed.boardRank = i + 1;
        boardData.push(JSON.stringify(parsed));
      }
    }
    if (boardData.length > 0) {
      sections.push(`### Board Players (${boardData.length}) — ordered by board rank\n[${boardData.join(',')}]`);
    }
  }

  // 5. Structured query
  if (needs.query) {
    const data = queryProspects(needs.query);
    if (!data.includes('"error"')) {
      const filterDesc = needs.query.filters.map(f => `${f.field} ${f.op} ${f.value}`).join(', ');
      const sortDesc = needs.query.sort ? ` sorted by ${needs.query.sort.field} ${needs.query.sort.order}` : '';
      sections.push(`### Query Results (${filterDesc}${sortDesc})\n${data}`);
    }
  }

  // 6. RAG scouting search (qualitative traits)
  //    Also fetch full measurements for RAG matches so the LLM can cross-reference
  //    (e.g. "receivers good at beating press" → RAG finds names → measurements for those names)
  //    When a structured query has a position filter, apply it to RAG too so results are position-scoped
  if (needs.ragQuery) {
    const posFilter = needs.query?.filters.find(f => f.field === 'pos' && f.op === 'eq')?.value as string | undefined;
    const data = await ragSearch(needs.ragQuery, 15, posFilter);
    const parsed = JSON.parse(data);
    if (parsed.results?.length > 0) {
      sections.push(`### Scouting Trait Search: "${needs.ragQuery}"\n${data}`);

      const alreadyFetched = new Set(needs.lookups.map(n => n.toLowerCase()));
      const ragDetails: string[] = [];
      for (const r of parsed.results as Array<{ name: string }>) {
        if (alreadyFetched.has(r.name.toLowerCase())) continue;
        alreadyFetched.add(r.name.toLowerCase());
        const detail = lookupProspectLight(r.name);
        if (!detail.includes('"error"')) {
          const p = JSON.parse(detail);
          // Format key fields prominently so the LLM doesn't miss them
          const lastStats = p.stats?.length ? p.stats[p.stats.length - 1] : null;
          const statsLine = lastStats
            ? `Latest stats (${lastStats.year}): ${Object.entries(lastStats).filter(([k]) => k !== 'year' && k !== 'notes').map(([k, v]) => `${k}=${v}`).join(', ')}`
            : 'No stats available';
          ragDetails.push(
            `**${p.name}** | ${p.pos}${p.posRank} | ${p.school} | Grade: ${p.grade || '—'} | OVR: ${p.ovrRank ?? '—'}\n` +
            `  Ht: ${p.ht || '—'}, Wt: ${p.wt || '—'}` +
            (p.combine ? ` | 40: ${p.combine.forty ?? '—'}, Vert: ${p.combine.vert ?? '—'}, Broad: ${p.combine.broad ?? '—'}, Shuttle: ${p.combine.shuttle ?? '—'}, 3Cone: ${p.combine.cone ?? '—'}, Bench: ${p.combine.bench ?? '—'}, Arm: ${p.combine.arm ?? '—'}, Hand: ${p.combine.hand ?? '—'}` : '') +
            `\n  ${statsLine}`
          );
        }
      }
      if (ragDetails.length > 0) {
        sections.push(`### Trait Match Profiles (${ragDetails.length})\n${ragDetails.join('\n\n')}`);
      }
    }
  }

  // 7. Top overall prospects
  if (needs.topN > 0) {
    const data = getTopProspects(needs.topN);
    sections.push(`### Overall Top ${needs.topN} Prospects (Beast Rankings)\n${data}`);
  }

  if (sections.length === 0) return '';

  return '\n\n---\n## Scouting Data (from Dane Brugler\'s "The Beast" 2026 NFL Draft Guide)\n\n' +
    sections.join('\n\n');
}

/** Call the LLM and handle truncated JSON recovery. */
async function callLLM(
  systemPrompt: string,
  history: ConversationEntry[],
  userMessage: string,
): Promise<BoardAIResponse> {
  try {
    return await chatJSONWithHistory<BoardAIResponse>(systemPrompt, history, userMessage);
  } catch (parseErr) {
    const raw = parseErr instanceof Error ? parseErr.message : String(parseErr);
    const boardMatch = raw.match(/"board"\s*:\s*\[([\s\S]*)/);
    if (boardMatch) {
      const names = [...boardMatch[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
      if (names.length > 0) {
        console.log(`[board-ai] Recovered ${names.length} names from truncated JSON`);
        return { action: 'submit_board', board: names, explanation: 'Recovered from truncated response' };
      }
    }
    throw parseErr;
  }
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
  const isPublic = interaction.options.getBoolean('public') === true && isAdmin(interaction);
  const ephemeral = !isPublic;
  await interaction.deferReply({ ephemeral });

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

    // Available prospects — limit to top 200 to keep prompt size manageable for Ollama Cloud
    const { prospects: availableProspects } = manager.getAvailableProspects(undefined, 1, 200);
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

    // Current strategy prompt
    const currentStrategy = manager.getStrategyPrompt(userTeam);

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
      currentStrategy,
      currentRoster,
      draftedPlayers,
      remainingPicks,
      strategyNotes,
    );

    // Save this input as a strategy note for future context
    manager.addStrategyNote(userTeam, description, 10);

    // ── LLM-powered pre-fetch: extract what scouting data the main call needs ──
    let enrichedMessage = userMessage;
    const boardNames = currentBoard.filter(b => b.pos !== '?').map(b => b.name);
    if (isBeastAvailable()) {
      const needs = await extractDataNeeds(description, interaction.user.id, boardNames);
      const scoutingCtx = await fetchScoutingData(needs, boardNames);
      if (scoutingCtx) {
        enrichedMessage += scoutingCtx;
        console.log(`[board-ai] Pre-injected ${scoutingCtx.length} chars of Beast scouting data`);
      }
    }

    console.log(`[board-ai] Prompt length: ${systemPrompt.length} chars, ~${Math.ceil(systemPrompt.length / 4)} tokens`);

    // ── Main LLM call ──
    const history = getHistory(interaction.user.id);
    const result = await callLLM(systemPrompt, history, enrichedMessage);

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

      // Save to history for follow-up
      addToHistory(interaction.user.id, 'user', userMessage);
      addToHistory(interaction.user.id, 'assistant', JSON.stringify(result));

      // Split into 2000-char chunks, breaking at newlines and keeping code fences balanced
      const chunks: string[] = [];
      let remaining = answer;
      while (remaining.length > 0) {
        if (remaining.length <= 2000) {
          chunks.push(remaining);
          break;
        }
        let splitAt = remaining.lastIndexOf('\n', 2000);
        if (splitAt < 500) splitAt = 2000;
        let chunk = remaining.slice(0, splitAt);
        remaining = remaining.slice(splitAt).replace(/^\n/, '');

        // If chunk has an unclosed code fence, close it and re-open in the next chunk
        const fenceCount = (chunk.match(/^```/gm) || []).length;
        if (fenceCount % 2 !== 0) {
          chunk += '\n```';
          remaining = '```\n' + remaining;
        }
        chunks.push(chunk);
      }

      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i], ephemeral });
      }
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
      const strategy = manager.getStrategyPrompt(userTeam);
      const embed = buildMyBoardEmbed(teamName, entries, page, totalPages, total, strategy, isBeastAvailable() ? getBeastRanking : undefined);

      clearHistory(interaction.user.id);
      await interaction.editReply({ content: reply, embeds: [embed] });
      return;
    }

    if (result.action === 'set_strategy') {
      const prompt = result.strategyPrompt?.trim();
      if (!prompt) {
        await interaction.editReply('❌ AI returned an empty strategy prompt. Try rephrasing.');
        return;
      }

      manager.setStrategyPrompt(userTeam, prompt);

      // Keep history so user can refine the strategy in follow-ups
      addToHistory(interaction.user.id, 'user', description);
      addToHistory(interaction.user.id, 'assistant', JSON.stringify(result));

      await interaction.editReply(
        `✅ **Draft Strategy Set for ${teamName}**\n` +
        `> ${result.explanation}\n\n` +
        `**Strategy:**\n${prompt}\n\n` +
        `This strategy will guide autopick decisions. You can refine it with follow-up messages.`
      );
      return;
    }

    if (result.action === 'clear') {
      const what = (result.clearWhat === 'board' || result.clearWhat === 'strategy') ? result.clearWhat : 'all';
      manager.clearBoard(userTeam, what);
      const label = what === 'board' ? 'custom board' : what === 'strategy' ? 'strategy prompt' : 'custom board and strategy';

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
    } else if (message.includes('Invalid JSON from LLM:') && message.includes('<!DOCTYPE')) {
      await interaction.editReply(
        '❌ **Request timed out** — the AI took too long to respond.\n\n' +
        'Tips to avoid this:\n' +
        '- Ask about fewer players at a time (e.g. "first 20" instead of "all 100")\n' +
        '- Ask about a specific position group instead of the whole board\n' +
        '- Keep follow-up questions simple (e.g. "compare their 40 times")\n' +
        '- Avoid asking for full scouting reports on large groups'
      );
      console.error('[board-ai] Cloudflare 524 timeout');
    } else if (message.startsWith('Invalid JSON from LLM:')) {
      // LLM returned raw text instead of JSON — try to recover the answer
      const rawText = message.replace('Invalid JSON from LLM: ', '').trim();
      if (rawText.length > 20 && !rawText.startsWith('{')) {
        console.warn('[board-ai] Recovering raw text answer from failed JSON parse');
        addToHistory(interaction.user.id, 'user', description);
        addToHistory(interaction.user.id, 'assistant', rawText);
        const chunks: string[] = [];
        let remaining = rawText;
        while (remaining.length > 0) {
          if (remaining.length <= 2000) { chunks.push(remaining); break; }
          let splitAt = remaining.lastIndexOf('\n', 2000);
          if (splitAt < 500) splitAt = 2000;
          let chunk = remaining.slice(0, splitAt);
          remaining = remaining.slice(splitAt).replace(/^\n/, '');
          const fenceCount = (chunk.match(/^```/gm) || []).length;
          if (fenceCount % 2 !== 0) { chunk += '\n```'; remaining = '```\n' + remaining; }
          chunks.push(chunk);
        }
        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i], ephemeral });
        }
      } else {
        await interaction.editReply('❌ AI returned an invalid response. Try rephrasing your question.');
        console.error('[board-ai] Unrecoverable JSON error:', message.slice(0, 500));
      }
    } else {
      const truncMsg = message.slice(0, 1800);
      await interaction.editReply(`❌ AI error: ${truncMsg}`);
      console.error('[board-ai] Error:', message);
    }
  }
}
