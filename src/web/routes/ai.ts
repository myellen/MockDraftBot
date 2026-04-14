import { Router } from 'express';
import type { RoomManager } from '../RoomManager';
import type { TokenPayload } from '../auth';
import { TEAMS } from '../../data/teams';
import { ALL_POSITIONS } from '../../data/prospects';
import { isOllamaConfigured, chatJSON, chatJSONWithHistory } from '../../llm/OllamaService';
import {
  lookupProspect, lookupProspectLight, lookupByPositionRank,
  searchByPosition, getTopProspects, queryProspects, ragSearch,
} from '../../data/beastScouting';
import type { ProspectQuery } from '../../data/beastScouting';

// ─── Conversation history ───────────────────────────────────────────────────

interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
}

const TRADE_MAX_HISTORY = 6;  // 3 exchanges
const BOARD_MAX_HISTORY = 10; // 5 exchanges

const tradeConversations = new Map<string, ConversationEntry[]>();
const boardConversations = new Map<string, ConversationEntry[]>();

function historyKey(roomCode: string, userId: string): string {
  return `${roomCode}:${userId}`;
}

function getHistory(map: Map<string, ConversationEntry[]>, key: string): ConversationEntry[] {
  return map.get(key) ?? [];
}

function addHistory(map: Map<string, ConversationEntry[]>, key: string, role: 'user' | 'assistant', content: string, max: number): void {
  const history = map.get(key) ?? [];
  history.push({ role, content });
  if (history.length > max) history.splice(0, history.length - max);
  map.set(key, history);
}

function clearHistory(map: Map<string, ConversationEntry[]>, key: string): void {
  map.delete(key);
}

// ─── Trade-AI types & prompt ────────────────────────────────────────────────

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

function buildTradeSystemPrompt(
  engine: any, myTeam: string, myTeamName: string,
): string {
  const state = engine.getState();

  const myPicks = engine.getFuturePicksForTeam(myTeam);
  const myRoster = engine.searchRosterPlayers(myTeam, '');
  const myFuturePicks = engine.getFuturePickRightsForTeam(myTeam);
  const myDraftedPlayers = engine.getTeamPicks(myTeam);

  const teamList = Object.entries(TEAMS)
    .map(([abbr, t]: [string, any]) => `${abbr} = ${t.name}`)
    .join('\n');

  const myPicksStr = myPicks.length > 0
    ? myPicks.map((p: any) => `  #${p.overall} (Round ${p.round}, Pick ${p.roundPick}${p.originalTeam !== myTeam ? ` — via ${p.originalTeam}` : ''})`).join('\n')
    : '  (none)';

  const myRosterStr = myRoster.length > 0
    ? myRoster.map((p: any) => `  ${p.name} (${p.pos})`).join('\n')
    : '  (none)';

  const myFutureStr = myFuturePicks.length > 0
    ? myFuturePicks.map((f: any) => `  ${f.year} Round ${f.round} (orig: ${f.originalTeam})`).join('\n')
    : '  (none)';

  const myDraftedStr = myDraftedPlayers.length > 0
    ? myDraftedPlayers.map((p: any) => `  #${p.overall}: ${p.prospectName} (${p.pos})`).join('\n')
    : '  (none yet)';

  const otherTeamsContext = Object.keys(TEAMS)
    .filter(abbr => abbr !== myTeam)
    .map(abbr => {
      const name = (TEAMS as any)[abbr].name;
      const picks = engine.getFuturePicksForTeam(abbr);
      const roster = engine.searchRosterPlayers(abbr, '');
      const futures = engine.getFuturePickRightsForTeam(abbr);

      const picksStr = picks.length > 0
        ? picks.map((p: any) => `#${p.overall}(R${p.round}.${p.roundPick}${p.originalTeam !== abbr ? ` via ${p.originalTeam}` : ''})`).join(', ')
        : '(none)';
      const rosterStr = roster.length > 0
        ? roster.map((p: any) => `${p.name} (${p.pos})`).join(', ')
        : '(none loaded)';
      const futureStr = futures.length > 0
        ? futures.map((f: any) => {
            const via = f.originalTeam !== abbr ? ` (via ${f.originalTeam})` : '';
            return `${f.year}R${f.round}${via}`;
          }).join(', ')
        : '';

      let section = `### ${name} (${abbr})\n  Picks: ${picksStr}\n  Roster: ${rosterStr}`;
      if (futureStr) section += `\n  Future picks: ${futureStr}`;
      return section;
    })
    .join('\n\n');

  const recentPicksStr = state.picks.length > 0
    ? state.picks.slice(-15).map((p: any) => `  #${p.overall} ${p.team}: ${p.prospectName} (${p.pos})`).join('\n')
    : '  (no picks made yet)';

  return `You are an NFL trade assistant for a mock draft. Your job is to parse a natural-language trade description into structured trade data.

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
- "offeredFuturePicks" and "requestedFuturePicks" are for picks in FUTURE years (2027, 2028) ONLY — use format like "2027R1", "2028R3". NEVER put 2026 picks here. If a team has multiple picks in the same round, append the original team abbreviation: "2027R5-CAR".
- "offeredPlayers" and "requestedPlayers" use exact player names as shown in the rosters above
- "offered" means what the user's team GIVES UP
- "requested" means what the user's team RECEIVES
- "targetTeam" is the OTHER team's abbreviation (e.g. "DAL", "NYJ")
- Match player names fuzzily — "Mahomes" → "Patrick Mahomes"
- Match team names fuzzily — "Cowboys" = "DAL", "Niners"/"49ers" = "SF", etc.
- When the user references a player by position, look up the target team's roster
- This is a CONVERSATION. If the user says "yes", "do it", "sure", they are confirming a trade you previously suggested. Build the trade proposal from your prior suggestion.
- Be PROACTIVE with suggestions. If vague, propose specific trades and set "clarification" to describe what you're proposing.
- If you cannot fully determine the trade but have a best guess, fill in the fields AND set "clarification".
- Only set "error" if you truly cannot figure out any reasonable interpretation.

## Response Format
Respond with ONLY valid JSON:
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

// ─── Board-AI types & prompts ───────────────────────────────────────────────

interface BoardAIResponse {
  action: 'submit_board' | 'set_strategy' | 'clear' | 'answer_question';
  board?: string[];
  strategyPrompt?: string;
  clearWhat?: 'board' | 'strategy' | 'all';
  answer?: string;
  explanation: string;
  error?: string;
}

interface DataNeeds {
  lookups: string[];
  posRanks: Array<{ pos: string; rank: number }>;
  posLists: Array<{ pos: string; count: number }>;
  board: boolean;
  topN: number;
  query?: ProspectQuery | null;
  ragQuery?: string | null;
}

const EXTRACTION_SYSTEM = `You extract NFL draft scouting data needs from a user query. Given the query, recent conversation context, and the user's board, determine what prospect data should be fetched from the scouting database.

Return ONLY JSON:
{
  "lookups": [],
  "posRanks": [],
  "posLists": [],
  "board": false,
  "topN": 0,
  "query": null,
  "ragQuery": null
}

Key rules:
- "edge 30" / "EDGE30" → posRanks: [{"pos":"EDGE","rank":30}]
- "top 30 edge rushers" → posLists: [{"pos":"EDGE","count":30}]
- "tell me about Cam Ward" → lookups: ["Cam Ward"]
- "tell me about him" → resolve from conversation context
- "compare X and Y" → lookups: ["X", "Y"]
- "best available" / "BPA" → topN: 20
- "draft for need" / "analyze my board" → board: true
- Position abbreviations: QB, RB, WR, TE, OT, G, C, EDGE, DT, LB, CB, S
- Default count for position lists is 10 unless specified
- If query is a simple board instruction with no scouting question, return all empty/false/0/null

Query object for flexible filtering/sorting:
{ "filters": [{"field": "...", "op": "...", "value": ...}], "sort": {"field": "...", "order": "asc"|"desc"}, "limit": 20 }

Available fields: pos, posRank, name, school, grade, ovrRank, age, ht (inches), wt (pounds), combine.forty, combine.vert, combine.broad, combine.shuttle, combine.cone, combine.bench, combine.hand, combine.arm, combine.wing, stats.sacks, stats.tackles, stats.passing_td, stats.passing_yards, stats.interceptions, stats.receptions, stats.receiving_yards, stats.receiving_td, stats.rushing_yards, stats.rushing_td
Operators: eq, neq, lt, gt, lte, gte, in, contains

ragQuery — for qualitative/trait-based scouting searches:
- "high motor" → ragQuery: "high motor"
- "good hands and route running" → ragQuery: "good hands route running"
- ragQuery can coexist with other fields

Follow-up handling: look at conversation history to determine what group was discussed. Re-fetch via posLists when a follow-up references a prior group.`;

function buildBoardSystemPrompt(
  engine: any, teamAbbr: string, teamName: string,
): string {
  const { prospects: availableProspects } = engine.getAvailableProspects(undefined, 1, 200);
  const boardRanks = engine.getCustomBoard(teamAbbr);
  const currentStrategy = engine.getStrategyPrompt(teamAbbr);
  const strategyNotes = engine.getStrategyNotes(teamAbbr);
  const currentRoster = engine.searchRosterPlayers(teamAbbr, '');
  const draftedPlayers = engine.getTeamPicks(teamAbbr);
  const remainingPicks = engine.getFuturePicksForTeam(teamAbbr).length;

  const prospectsStr = availableProspects
    .map((p: any) => `${p.rank}. ${p.name}|${p.pos}|${p.school}`)
    .join('\n');

  // Build current board display from ranks
  const currentBoard: Array<{ rank: number; name: string; pos: string }> = [];
  for (const rank of boardRanks) {
    const p = availableProspects.find((pr: any) => pr.rank === rank);
    if (p) currentBoard.push({ rank, name: p.name, pos: p.pos });
  }

  const boardStr = currentBoard.length > 0
    ? currentBoard.map((p, i) => `  ${i + 1}. ${p.name} (${p.pos})`).join('\n')
    : '  (no custom board set)';

  const strategyStr = currentStrategy ?? '(none set — use set_strategy to create one)';

  const rosterStr = currentRoster.length > 0
    ? currentRoster.map((p: any) => `${p.name}|${p.pos}`).join(', ')
    : '(none loaded)';

  const draftedStr = draftedPlayers.length > 0
    ? draftedPlayers.map((p: any) => `  #${p.overall}: ${p.prospectName} (${p.pos})`).join('\n')
    : '  (none yet)';

  const defaultBoardSize = Math.max(10, remainingPicks * 2);

  return `You are an NFL draft scout and board assistant for a mock draft. You can answer questions about prospects, team needs, and draft strategy, AND parse board change instructions into structured data.

The user controls the **${teamName} (${teamAbbr})**.

## Current Roster
${rosterStr}

## Players Already Drafted This Session
${draftedStr}

## Available Prospects
${prospectsStr}

## Current Custom Board
${boardStr}

## Current Draft Strategy
${strategyStr}

## Valid Positions
${ALL_POSITIONS.join(', ')}
${strategyNotes.length > 0 ? `
## Recent GM Instructions
${strategyNotes.map((n: string, i: number) => `  ${i + 1}. "${n}"`).join('\n')}
` : ''}
## Actions You Can Take

### 1. submit_board
Set a custom draft board. Board array must contain ONLY bare player names matching the "Available Prospects" list exactly.
Default board size: ~${defaultBoardSize} players. Only return more if explicitly asked.

### 2. set_strategy
Set a draft strategy prompt (2-6 sentences). Before committing, ask follow-up questions if the request is vague.

### 3. clear
Clear the custom board, strategy, or both. Set "clearWhat" to "board", "strategy", or "all".

### 4. answer_question
Answer questions about prospects, team needs, draft strategy. Use the "answer" field (plain text, markdown OK).
Keep answers concise but thorough. When scouting data is appended, cite specific insights.

## Rules
- This is a CONVERSATION. If the user says "put those on my board", they reference prospects from your previous answer.
- Questions → answer_question. Instructions → appropriate board action.
- Match player names fuzzily. If ambiguous, pick the best context match.
- If you cannot determine the intent, set "error" to a helpful message.

## Response Format
Respond with ONLY valid JSON:
{
  "action": "submit_board" | "set_strategy" | "clear" | "answer_question",
  "board": ["Player Name 1", ...],
  "strategyPrompt": "...",
  "clearWhat": "board" | "strategy" | "all",
  "answer": "Your detailed answer",
  "explanation": "Brief explanation",
  "error": null
}`;
}

// ─── Scouting data extraction & fetching ────────────────────────────────────

async function extractDataNeeds(
  description: string,
  historyKey: string,
  boardNames: string[],
): Promise<DataNeeds> {
  const fallback: DataNeeds = { lookups: [], posRanks: [], posLists: [], board: false, topN: 0 };

  try {
    const history = getHistory(boardConversations, historyKey);
    let contextBlock = '';
    if (history.length > 0) {
      const recent = history.slice(-4);
      const parts: string[] = [];
      for (const h of recent) {
        const label = h.role === 'user' ? 'User' : 'AI';
        parts.push(`${label}: ${h.content.slice(0, 1500)}`);
      }
      contextBlock = `\nConversation history:\n${parts.join('\n')}`;
    }
    const boardBlock = boardNames.length > 0
      ? `\nUser's board players: ${boardNames.slice(0, 20).join(', ')}`
      : '';

    const userMsg = `Query: ${description}${contextBlock}${boardBlock}`;
    const result = await chatJSON<DataNeeds>(EXTRACTION_SYSTEM, userMsg);

    return {
      lookups: Array.isArray(result.lookups) ? result.lookups.slice(0, 15) : [],
      posRanks: Array.isArray(result.posRanks) ? result.posRanks.slice(0, 5) : [],
      posLists: Array.isArray(result.posLists) ? result.posLists.slice(0, 3) : [],
      board: !!result.board,
      topN: typeof result.topN === 'number' ? Math.min(result.topN, 30) : 0,
      query: result.query && Array.isArray((result.query as any).filters) ? result.query : null,
      ragQuery: typeof result.ragQuery === 'string' && result.ragQuery.trim() ? result.ragQuery.trim() : null,
    };
  } catch (err) {
    console.warn('[ai-route] Extraction failed, proceeding without pre-fetch:', err instanceof Error ? err.message : err);
    return fallback;
  }
}

async function fetchScoutingData(needs: DataNeeds, boardNames: string[]): Promise<string> {
  const sections: string[] = [];

  for (const name of needs.lookups) {
    const data = lookupProspect(name);
    if (!data.includes('"error"')) sections.push(`### Scouting Report: ${name}\n${data}`);
  }

  for (const { pos, rank } of needs.posRanks) {
    const data = lookupByPositionRank(pos, rank);
    if (!data.includes('"error"')) sections.push(`### ${pos} #${rank} Scouting Report\n${data}`);
  }

  for (const { pos, count } of needs.posLists) {
    const data = searchByPosition(pos, Math.min(count, 30));
    if (!data.includes('"error"')) sections.push(`### Top ${count} ${pos} Prospects\n${data}`);
  }

  if (needs.board && boardNames.length > 0) {
    const alreadyFetched = new Set(needs.lookups.map(n => n.toLowerCase()));
    const boardData: string[] = [];
    for (let i = 0; i < boardNames.length; i++) {
      const name = boardNames[i];
      if (alreadyFetched.has(name.toLowerCase())) continue;
      const data = lookupProspectLight(name);
      if (!data.includes('"error"')) {
        const parsed = JSON.parse(data);
        parsed.boardRank = i + 1;
        boardData.push(JSON.stringify(parsed));
      }
    }
    if (boardData.length > 0) sections.push(`### Board Players (${boardData.length})\n[${boardData.join(',')}]`);
  }

  if (needs.query) {
    const data = queryProspects(needs.query);
    if (!data.includes('"error"')) {
      const filterDesc = (needs.query as any).filters.map((f: any) => `${f.field} ${f.op} ${f.value}`).join(', ');
      sections.push(`### Query Results (${filterDesc})\n${data}`);
    }
  }

  if (needs.ragQuery) {
    const posFilter = (needs.query as any)?.filters?.find((f: any) => f.field === 'pos' && f.op === 'eq')?.value as string | undefined;
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
        if (!detail.includes('"error"')) ragDetails.push(detail);
      }
      if (ragDetails.length > 0) sections.push(`### Trait Match Profiles\n[${ragDetails.join(',')}]`);
    }
  }

  if (needs.topN > 0) {
    const data = getTopProspects(needs.topN);
    sections.push(`### Overall Top ${needs.topN} Prospects\n${data}`);
  }

  if (sections.length === 0) return '';
  return '\n\n---\n## Scouting Data\n\n' + sections.join('\n\n');
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export function aiRoutes(rm: RoomManager): Router {
  const router = Router();

  // ── Trade-AI ────────────────────────────────────────────────────────────────

  router.post('/:code/trade-ai', async (req, res) => {
    if (!isOllamaConfigured()) {
      res.status(503).json({ success: false, error: 'AI features not configured.' });
      return;
    }

    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }

    const user = (req as any).user as TokenPayload;
    const engine = room.adapter.engine;
    const userTeam = engine.getUserTeam(user.userId);
    if (!userTeam) { res.status(400).json({ success: false, error: 'Register for a team first.' }); return; }

    const { message } = req.body ?? {};
    if (!message) { res.status(400).json({ success: false, error: 'message is required.' }); return; }

    const key = historyKey(req.params.code, user.userId);

    try {
      const teamName = (TEAMS as any)[userTeam]?.name ?? userTeam;
      const systemPrompt = buildTradeSystemPrompt(engine, userTeam, teamName);
      const history = getHistory(tradeConversations, key);

      console.log(`[trade-ai-web] User=${user.userId} Team=${userTeam} Input="${message}"`);
      const result = await chatJSONWithHistory<TradeAIResponse>(systemPrompt, history, message);
      console.log(`[trade-ai-web] LLM response: target=${result.targetTeam}, clarification=${result.clarification ?? 'none'}`);

      addHistory(tradeConversations, key, 'user', message, TRADE_MAX_HISTORY);

      if (result.error) {
        addHistory(tradeConversations, key, 'assistant', result.error, TRADE_MAX_HISTORY);
        res.json({ success: true, response: result, tradeResult: null });
        return;
      }

      if (result.clarification) {
        addHistory(tradeConversations, key, 'assistant', JSON.stringify(result), TRADE_MAX_HISTORY);
        res.json({ success: true, response: result, tradeResult: null });
        return;
      }

      // Validate target team
      if (!result.targetTeam || !(TEAMS as any)[result.targetTeam]) {
        const msg = 'Could not determine the target team. Try being more specific.';
        addHistory(tradeConversations, key, 'assistant', msg, TRADE_MAX_HISTORY);
        res.json({ success: true, response: { ...result, error: msg }, tradeResult: null });
        return;
      }

      // Resolve future pick strings to IDs
      const state = engine.getState();
      const parseFuturePickStr = (s: string, teamAbbr: string): string | null => {
        const m = s.match(/^(\d{4})[Rr](\d)(?:-([A-Z]{2,3}))?$/);
        if (!m) return null;
        const year = parseInt(m[1], 10);
        const round = parseInt(m[2], 10);
        const origTeam = m[3] || undefined;
        const right = engine.resolveFuturePickRight(teamAbbr, year, round, origTeam);
        return right?.id ?? null;
      };

      const offeredFutureIds: string[] = [];
      for (const fp of result.offeredFuturePicks ?? []) {
        const id = parseFuturePickStr(fp, userTeam);
        if (id) offeredFutureIds.push(id);
      }
      const requestedFutureIds: string[] = [];
      for (const fp of result.requestedFuturePicks ?? []) {
        const id = parseFuturePickStr(fp, result.targetTeam);
        if (id) requestedFutureIds.push(id);
      }

      // Auto-propose the trade
      const receiverUserId = state.assignments[result.targetTeam] ?? 'cpu';
      const isCPU = !state.assignments[result.targetTeam];
      const tradeResult = await engine.trades.proposeTrade(
        user.userId, receiverUserId,
        result.offeredPicks ?? [], result.requestedPicks ?? [],
        result.offeredPlayers ?? [], result.requestedPlayers ?? [],
        offeredFutureIds, requestedFutureIds,
        isCPU ? result.targetTeam : undefined,
      );

      if (tradeResult.success && tradeResult.trade && isCPU) {
        void engine.aiGM.handleHumanProposal(tradeResult.trade).catch(() => {});
      }

      if (tradeResult.success) {
        clearHistory(tradeConversations, key);
      } else {
        addHistory(tradeConversations, key, 'assistant', `Trade failed: ${tradeResult.error}`, TRADE_MAX_HISTORY);
      }

      res.json({ success: true, response: result, tradeResult });
    } catch (err: any) {
      console.error('[trade-ai-web] Error:', err.message);
      res.status(500).json({ success: false, error: err.message ?? 'AI error.' });
    }
  });

  // ── Board-AI ────────────────────────────────────────────────────────────────

  router.post('/:code/board-ai', async (req, res) => {
    if (!isOllamaConfigured()) {
      res.status(503).json({ success: false, error: 'AI features not configured.' });
      return;
    }

    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }

    const user = (req as any).user as TokenPayload;
    const engine = room.adapter.engine;
    const userTeam = engine.getUserTeam(user.userId);
    if (!userTeam) { res.status(400).json({ success: false, error: 'Register for a team first.' }); return; }

    const { message } = req.body ?? {};
    if (!message) { res.status(400).json({ success: false, error: 'message is required.' }); return; }

    const key = historyKey(req.params.code, user.userId);

    try {
      const teamName = (TEAMS as any)[userTeam]?.name ?? userTeam;

      // Get board names for extraction context
      const boardRanks = engine.getCustomBoard(userTeam);
      const { prospects: allProspects } = engine.getAvailableProspects(undefined, 1, 500);
      const boardNames = boardRanks
        .map((rank: number) => allProspects.find((p: any) => p.rank === rank)?.name)
        .filter(Boolean) as string[];

      console.log(`[board-ai-web] User=${user.userId} Team=${userTeam} Input="${message}"`);

      // Phase 1: Extract data needs
      const needs = await extractDataNeeds(message, key, boardNames);
      console.log(`[board-ai-web] Extraction: lookups=${needs.lookups.length}, posLists=${needs.posLists.length}, ragQuery=${needs.ragQuery ?? 'none'}`);

      // Phase 2: Fetch scouting data
      const scoutingData = await fetchScoutingData(needs, boardNames);

      // Phase 3: Main LLM call
      const systemPrompt = buildBoardSystemPrompt(engine, userTeam, teamName);
      const history = getHistory(boardConversations, key);
      const enrichedMessage = scoutingData ? `${message}${scoutingData}` : message;

      let result: BoardAIResponse;
      try {
        result = await chatJSONWithHistory<BoardAIResponse>(systemPrompt, history, enrichedMessage);
      } catch (parseErr: any) {
        // Try to recover truncated board response
        const raw = parseErr.message ?? '';
        const boardMatch = raw.match(/"board"\s*:\s*\[([\s\S]*)/);
        if (boardMatch) {
          const names = [...boardMatch[1].matchAll(/"([^"]+)"/g)].map((m: any) => m[1]);
          if (names.length > 0) {
            result = { action: 'submit_board', board: names, explanation: 'Recovered from truncated response' };
          } else throw parseErr;
        } else throw parseErr;
      }

      console.log(`[board-ai-web] LLM action=${result.action}`);

      addHistory(boardConversations, key, 'user', message, BOARD_MAX_HISTORY);

      if (result.error) {
        addHistory(boardConversations, key, 'assistant', result.error, BOARD_MAX_HISTORY);
        res.json({ success: true, response: result, boardResult: null });
        return;
      }

      // Execute the action
      let boardResult: any = null;

      if (result.action === 'submit_board' && result.board && result.board.length > 0) {
        boardResult = engine.submitBoard(userTeam, result.board);
        const summary = `Board updated: ${boardResult.matched} matched${boardResult.unmatched?.length > 0 ? `, unmatched: ${boardResult.unmatched.join(', ')}` : ''}`;
        addHistory(boardConversations, key, 'assistant', summary, BOARD_MAX_HISTORY);
        engine.addStrategyNote(userTeam, message);
      } else if (result.action === 'set_strategy' && result.strategyPrompt) {
        engine.setStrategyPrompt(userTeam, result.strategyPrompt);
        boardResult = { strategy: result.strategyPrompt };
        addHistory(boardConversations, key, 'assistant', `Strategy set: ${result.strategyPrompt}`, BOARD_MAX_HISTORY);
        engine.addStrategyNote(userTeam, message);
      } else if (result.action === 'clear') {
        engine.clearBoard(userTeam, result.clearWhat ?? 'all');
        boardResult = { cleared: result.clearWhat ?? 'all' };
        addHistory(boardConversations, key, 'assistant', `Cleared: ${result.clearWhat ?? 'all'}`, BOARD_MAX_HISTORY);
      } else if (result.action === 'answer_question') {
        addHistory(boardConversations, key, 'assistant', result.answer ?? result.explanation, BOARD_MAX_HISTORY);
      }

      res.json({ success: true, response: result, boardResult });
    } catch (err: any) {
      console.error('[board-ai-web] Error:', err.message);
      res.status(500).json({ success: false, error: err.message ?? 'AI error.' });
    }
  });

  // ── Clear AI conversation history ───────────────────────────────────────────

  router.post('/:code/ai/clear-history', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const key = historyKey(req.params.code, user.userId);
    const { type } = req.body ?? {};
    if (type === 'trade' || type === 'all') clearHistory(tradeConversations, key);
    if (type === 'board' || type === 'all') clearHistory(boardConversations, key);
    res.json({ success: true });
  });

  return router;
}
