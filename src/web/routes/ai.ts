import { Router } from 'express';
import type { RoomManager } from '../RoomManager';
import type { TokenPayload } from '../auth';
import { TEAMS } from '../../data/teams';
import { ALL_POSITIONS } from '../../data/prospects';
import { TEAM_DRAFT_INTEL, DRAFT_KNOWLEDGE_BLOCK } from '../../data/boardSystemPrompt';
import { DRAFT_MODE } from '../../data/draftMode';
import { isAvailable as isBeastAvailable } from '../../data/beastScouting';
import { isOllamaConfigured, chatJSONWithHistory } from '../../llm/OllamaService';
import {
  extractDataNeeds as sharedExtractDataNeeds,
  fetchScoutingData,
  type DataNeeds,
} from '../../llm/BoardAIService';
import { ConversationHistory } from '../../utils/conversationHistory';

// ─── Conversation history ───────────────────────────────────────────────────

const tradeConversations = new ConversationHistory(6);  // 3 exchanges
const boardConversations = new ConversationHistory(10); // 5 exchanges

function historyKey(roomCode: string, userId: string): string {
  return `${roomCode}:${userId}`;
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

  const redraftNote = DRAFT_MODE === 'redraft'
    ? '\n\nMODE: League-wide REDRAFT — every current NFL player is in the draft pool and all rosters start empty. There are NO veteran/player trades in this mode; trades involve picks and future picks ONLY. Leave "offeredPlayers"/"requestedPlayers" empty.'
    : '';
  return `You are an NFL trade assistant for a mock draft. Your job is to parse a natural-language trade description into structured trade data.${redraftNote}

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
- This is the **2026 NFL ${DRAFT_MODE === 'redraft' ? 'Redraft' : 'Draft'}**. The picks listed under "Available Draft Picks (current year)" are 2026 picks.
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

  return `You are an NFL ${DRAFT_MODE === 'redraft' ? 'redraft GM assistant for a league-wide redraft of current NFL players — every player is in the pool, all rosters start empty, and pool IDs ARE the consensus value ranking (lower = better)' : 'draft scout and board assistant for a mock draft'}. You can answer questions about ${DRAFT_MODE === 'redraft' ? 'players' : 'prospects'}, team needs, and draft strategy, AND parse board change instructions into structured data.

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
${TEAM_DRAFT_INTEL[teamAbbr] ? `
## ${teamAbbr} Draft Intelligence
${TEAM_DRAFT_INTEL[teamAbbr]}
` : ''}
${DRAFT_KNOWLEDGE_BLOCK}

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

// ─── Scouting data extraction & fetching (delegates to shared BoardAIService) ──

async function extractDataNeeds(
  description: string,
  historyKey: string,
  boardNames: string[],
): Promise<DataNeeds> {
  const history = boardConversations.get(historyKey);
  return sharedExtractDataNeeds(description, history, boardNames);
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
      const history = tradeConversations.get(key);

      console.log(`[trade-ai-web] User=${user.userId} Team=${userTeam} Input="${message}"`);
      const result = await chatJSONWithHistory<TradeAIResponse>(systemPrompt, history, message);
      console.log(`[trade-ai-web] LLM response: target=${result.targetTeam}, clarification=${result.clarification ?? 'none'}`);

      tradeConversations.add(key, 'user', message);

      if (result.error) {
        tradeConversations.add(key, 'assistant', result.error);
        res.json({ success: true, response: result, tradeResult: null });
        return;
      }

      if (result.clarification) {
        tradeConversations.add(key, 'assistant', JSON.stringify(result));
        res.json({ success: true, response: result, tradeResult: null });
        return;
      }

      // Validate target team
      if (!result.targetTeam || !(TEAMS as any)[result.targetTeam]) {
        const msg = 'Could not determine the target team. Try being more specific.';
        tradeConversations.add(key, 'assistant', msg);
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
        tradeConversations.clear(key);
      } else {
        tradeConversations.add(key, 'assistant', `Trade failed: ${tradeResult.error}`);
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

      // Phase 1+2: extract data needs and fetch scouting data — skip both when
      // no scouting corpus is loaded (e.g. redraft mode) to save the LLM call
      let scoutingData = '';
      if (isBeastAvailable()) {
        const needs = await extractDataNeeds(message, key, boardNames);
        console.log(`[board-ai-web] Extraction: lookups=${needs.lookups.length}, posLists=${needs.posLists.length}, ragQuery=${needs.ragQuery ?? 'none'}`);
        scoutingData = await fetchScoutingData(needs, boardNames);
      }

      // Phase 3: Main LLM call
      const systemPrompt = buildBoardSystemPrompt(engine, userTeam, teamName);
      const history = boardConversations.get(key);
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

      boardConversations.add(key, 'user', message);

      if (result.error) {
        boardConversations.add(key, 'assistant', result.error);
        res.json({ success: true, response: result, boardResult: null });
        return;
      }

      // Execute the action
      let boardResult: any = null;

      if (result.action === 'submit_board' && result.board && result.board.length > 0) {
        boardResult = engine.submitBoard(userTeam, result.board);
        const summary = `Board updated: ${boardResult.matched} matched${boardResult.unmatched?.length > 0 ? `, unmatched: ${boardResult.unmatched.join(', ')}` : ''}`;
        boardConversations.add(key, 'assistant', summary);
        engine.addStrategyNote(userTeam, message);
      } else if (result.action === 'set_strategy' && result.strategyPrompt) {
        engine.setStrategyPrompt(userTeam, result.strategyPrompt);
        boardResult = { strategy: result.strategyPrompt };
        boardConversations.add(key, 'assistant', `Strategy set: ${result.strategyPrompt}`);
        engine.addStrategyNote(userTeam, message);
      } else if (result.action === 'clear') {
        engine.clearBoard(userTeam, result.clearWhat ?? 'all');
        boardResult = { cleared: result.clearWhat ?? 'all' };
        boardConversations.add(key, 'assistant', `Cleared: ${result.clearWhat ?? 'all'}`);
      } else if (result.action === 'answer_question') {
        boardConversations.add(key, 'assistant', result.answer ?? result.explanation);
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
    if (type === 'trade' || type === 'all') tradeConversations.clear(key);
    if (type === 'board' || type === 'all') boardConversations.clear(key);
    res.json({ success: true });
  });

  return router;
}
