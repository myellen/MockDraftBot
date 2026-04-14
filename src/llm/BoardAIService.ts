/**
 * Shared board-AI pipeline: extraction, scouting data fetch, and GM research.
 * Used by Discord board-ai command, web board-ai route, and GM extra research.
 */

import { chatJSON, chatText } from './OllamaService';
import {
  lookupProspect, lookupProspectLight, lookupByPositionRank,
  searchByPosition, getTopProspects, queryProspects, ragSearch,
} from '../data/beastScouting';
import type { ProspectQuery } from '../data/beastScouting';

// ── Types ──────────────────────────────────────────────────────────────────

export interface DataNeeds {
  lookups: string[];
  posRanks: Array<{ pos: string; rank: number }>;
  posLists: Array<{ pos: string; count: number }>;
  board: boolean;
  topN: number;
  query?: ProspectQuery | null;
  ragQuery?: string | null;
}

export interface GMResearchContext {
  teamAbbr: string;
  teamName: string;
  boardTopAvailable: Array<{ rank: number; name: string; pos: string; school: string }>;
  pickInfo: { round: number; roundPick: number; overall: number };
  strategy: string;
  draftedByTeam: Array<{ name: string; pos: string }>;
}

// ── Extraction prompt ──────────────────────────────────────────────────────

export const EXTRACTION_SYSTEM = `You extract NFL draft scouting data needs from a user query. Given the query, recent conversation context, and the user's board, determine what prospect data should be fetched from the scouting database.

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

// ── Extraction ─────────────────────────────────────────────────────────────

import type { ConversationEntry } from '../utils/conversationHistory';

/**
 * Use a fast LLM call to determine what scouting data the main call needs.
 * Falls back to empty data on failure.
 */
export async function extractDataNeeds(
  description: string,
  history: ConversationEntry[],
  boardNames: string[],
): Promise<DataNeeds> {
  const fallback: DataNeeds = { lookups: [], posRanks: [], posLists: [], board: false, topN: 0 };

  try {
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
    console.log(`[BoardAI] Extraction call: ${userMsg.length} chars`);

    const result = await chatJSON<DataNeeds>(EXTRACTION_SYSTEM, userMsg);
    console.log(`[BoardAI] Extraction result: ${JSON.stringify(result)}`);

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
    console.warn('[BoardAI] Extraction call failed, proceeding without pre-fetch:', err instanceof Error ? err.message : err);
    return fallback;
  }
}

// ── Scouting data fetch ────────────────────────────────────────────────────

export async function fetchScoutingData(needs: DataNeeds, boardNames: string[]): Promise<string> {
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

  // 4. Board player lookups — light version (measurements + stats, no writeup text)
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

// ── GM Research ────────────────────────────────────────────────────────────

/**
 * Pre-pick research for AI GMs. Runs the board-ai extraction → fetch → analysis pipeline.
 * Returns a concise scouting summary, or empty string on failure.
 *
 * LLM calls: 1 (extraction) + 1 (analysis) = 2 total.
 */
export async function gmResearch(ctx: GMResearchContext): Promise<string> {
  const boardList = ctx.boardTopAvailable
    .map((p, i) => `${i + 1}. ${p.name} (${p.pos}, ${p.school})`)
    .join('\n');

  const draftedList = ctx.draftedByTeam.length > 0
    ? ctx.draftedByTeam.map(p => `${p.name} (${p.pos})`).join(', ')
    : 'none';

  const query = `You are the ${ctx.teamName} GM picking at #${ctx.pickInfo.overall} (Round ${ctx.pickInfo.round}, Pick ${ctx.pickInfo.roundPick}). Top available on your board:\n${boardList}\nStrategy: ${ctx.strategy}\nAlready drafted: ${draftedList}\nWhat scouting data do you want before picking?`;

  // Step 1: Extraction — GM decides what to research
  const boardNames = ctx.boardTopAvailable.map(p => p.name);
  const needs = await extractDataNeeds(query, [], boardNames);
  console.log(`[BoardAI] GM extraction for ${ctx.teamAbbr}: ${JSON.stringify(needs)}`);

  // Step 2: Fetch scouting data (no LLM)
  const scoutingData = await fetchScoutingData(needs, boardNames);
  if (!scoutingData) return '';

  // Step 3: Analysis — summarize research for the pick decision
  const analysisSystem = `You are an NFL GM scout. Analyze this scouting data for the ${ctx.teamName} picking at #${ctx.pickInfo.overall}. Summarize key findings about the top prospects and recommend who fits best given the team's strategy and needs. Be concise (under 400 words).`;

  const analysisUser = `Team: ${ctx.teamAbbr} | Round ${ctx.pickInfo.round}, Pick ${ctx.pickInfo.roundPick} (#${ctx.pickInfo.overall})\nStrategy: ${ctx.strategy}\nAlready drafted: ${draftedList}\n\n${scoutingData}`;

  try {
    const analysis = await chatText(analysisSystem, analysisUser);
    console.log(`[BoardAI] GM research for ${ctx.teamAbbr}: ${analysis.slice(0, 100)}...`);
    return analysis;
  } catch (err) {
    console.warn(`[BoardAI] GM analysis failed for ${ctx.teamAbbr}:`, err instanceof Error ? err.message : err);
    return '';
  }
}
