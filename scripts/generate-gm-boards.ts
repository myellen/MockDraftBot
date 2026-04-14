/**
 * Generate AI GM draft boards via multi-turn scouting conversations.
 *
 * For each team, the GM persona (using the large wiki-based profile)
 * converses with the scouting department (Beast data) across several turns,
 * asking about position groups, specific prospects, and traits.
 * After research, the GM submits a ranked draft board.
 *
 * Usage:
 *   npx ts-node scripts/generate-gm-boards.ts
 *   npx ts-node scripts/generate-gm-boards.ts --team BUF
 *   npx ts-node scripts/generate-gm-boards.ts --team BUF --team MIA
 *   npx ts-node scripts/generate-gm-boards.ts --turns 5
 *   npx ts-node scripts/generate-gm-boards.ts --dry-run
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Ollama } from 'ollama';
import * as fs from 'fs';
import * as path from 'path';
import { getAllGMProfiles, type GMProfile } from '../src/data/gmProfiles';
import { PROSPECTS } from '../src/data/prospects';
import {
  lookupProspect, searchByPosition, getTopProspects,
  queryProspects, ragSearch, getAllProspectsRaw, type ProspectQuery,
} from '../src/data/beastScouting';
import { TEAMS } from '../src/data/teams';

// ── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function collectFlag(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1].toUpperCase());
  }
  return values;
}

function numFlag(flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1]) : fallback;
}

const teamFilter = new Set(collectFlag('--team'));
const dryRun = args.includes('--dry-run');
const researchTurns = numFlag('--turns', 4);
const numCtx = numFlag('--ctx', 65536);
const BOARD_SIZE = 150;

const OUTPUT_PATH = path.join(__dirname, '..', 'src', 'data', 'gmBoards.ts');
const WIKI_DIR = path.join(__dirname, '..', 'wikiBasedPrompts');

// ── GM name extraction ─────────────────────────────────────────────────────

function getGMName(profile: GMProfile): string {
  const match = profile.personality.match(/^ROLE:\s*([^,]+),/);
  return match ? match[1].trim() : '';
}

function loadWikiProfile(gmName: string): string | null {
  const filePath = path.join(WIKI_DIR, `${gmName}.md`);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Strip the scenario-response instructions from the wiki profile
 * (everything from "### How to Respond" or "### Scenario Format" onward)
 * and replace with board-building context.
 */
function trimWikiProfile(wiki: string): string {
  const cutPoints = ['### How to Respond', '### Scenario Format'];
  let cutIdx = wiki.length;
  for (const marker of cutPoints) {
    const idx = wiki.indexOf(marker);
    if (idx > 0) cutIdx = Math.min(cutIdx, idx);
  }
  // Also cut the preceding "---" separator if it's within 5 lines
  let trimmed = wiki.slice(0, cutIdx).trimEnd();
  if (trimmed.endsWith('---')) trimmed = trimmed.slice(0, -3).trimEnd();
  return trimmed;
}

// ── Prospect list (light data for the system prompt) ──────────────────────

function buildProspectList(): string {
  return PROSPECTS.slice(0, 250).map(p =>
    `${p.rank}. ${p.name} | ${p.pos} | ${p.school}`
  ).join('\n');
}

// ── System prompt ──────────────────────────────────────────────────────────

function buildSystemPrompt(wikiProfile: string, gmName: string, teamAbbr: string): string {
  const trimmed = trimWikiProfile(wikiProfile);

  return `${trimmed}

---

## BOARD-BUILDING SESSION

You are in your war room preparing your 2026 NFL Draft board. Your scouting department has full access to Dane Brugler's "The Beast" — comprehensive scouting reports on 2,500+ prospects with grades, combine data, strengths/weaknesses, and film summaries.

You will have **${researchTurns} research turns** to ask your scouts about prospects. After that, you MUST submit your board.

### Research Turn Format

Each research turn, respond with ONLY this JSON:
{
  "mode": "research",
  "thinking": "Your reasoning about what you want to evaluate and why",
  "lookups": ["Prospect Name"],
  "posLists": [{"pos": "EDGE", "count": 15}],
  "topN": 0,
  "ragQuery": null,
  "query": null
}

Field guide:
- **lookups**: Names of specific prospects you want full scouting reports on (strengths, weaknesses, grades, combine, summary). Up to 10 per turn.
- **posLists**: Position groups to review. Returns ranked list with measurements and stats. e.g. [{"pos": "WR", "count": 20}]
- **topN**: Get the top N overall prospects (Beast rankings). Set to 0 if not needed.
- **ragQuery**: Trait-based semantic search. e.g. "high motor pass rusher", "elite route runner", "scheme versatile safety". Returns prospects matching the trait description.
- **query**: Structured filter/sort. JSON object: {"filters": [{"field": "...", "op": "...", "value": ...}], "sort": {"field": "...", "order": "asc"|"desc"}, "limit": 20}
  Fields: pos, wt, ht, age, ovrRank, combine.forty, combine.vert, combine.broad, combine.shuttle, combine.cone, combine.bench, combine.hand, combine.arm
  Operators: eq, neq, lt, gt, lte, gte, in, contains

Use ALL tools available to you. Get position group rankings for your priority needs. Look up specific targets. Search for traits that match your scheme. Compare prospects with structured queries.

### Board Submission Format

When you've done enough research (or on your final turn), respond with:
{
  "mode": "submit",
  "thinking": "Your board-building rationale — explain your philosophy and key decisions",
  "board": ["Prospect Name 1", "Prospect Name 2", ...]
}

Board rules:
- Rank at least ${BOARD_SIZE} prospects. The more the better.
- Names must EXACTLY match the prospect list provided.
- Your #1 = the player you'd take at #1 overall.
- This is YOUR board. It should reflect your distinct philosophy — not a generic consensus ranking.
- Consider: team needs, positional value, scheme fit, your archetype's evaluation philosophy.
- Balance BPA with team needs according to how YOU specifically approach the draft.
- Prospects you scouted in detail should be placed with conviction. Use the data.`;
}

// ── Scouting data fetcher (reuses Beast infrastructure) ───────────────────

interface GMDataNeed {
  lookups?: string[];
  posLists?: Array<{ pos: string; count: number }>;
  topN?: number;
  ragQuery?: string | null;
  query?: ProspectQuery | null;
}

async function fetchScoutingData(needs: GMDataNeed): Promise<string> {
  const sections: string[] = [];

  // Specific prospect lookups
  if (needs.lookups?.length) {
    for (const name of needs.lookups.slice(0, 10)) {
      const data = lookupProspect(name);
      if (!data.includes('"error"')) {
        sections.push(`### Scouting Report: ${name}\n${data}`);
      } else {
        sections.push(`### ${name}: No scouting report found in database`);
      }
    }
  }

  // Position group lists
  if (needs.posLists?.length) {
    for (const { pos, count } of needs.posLists.slice(0, 4)) {
      const data = searchByPosition(pos, Math.min(count, 30));
      if (!data.includes('"error"')) {
        sections.push(`### Top ${count} ${pos} Prospects (Beast Rankings)\n${data}`);
      }
    }
  }

  // Top N overall
  if (needs.topN && needs.topN > 0) {
    const data = getTopProspects(Math.min(needs.topN, 50));
    sections.push(`### Overall Top ${needs.topN} Prospects (Beast Rankings)\n${data}`);
  }

  // RAG trait search
  if (needs.ragQuery?.trim()) {
    const data = await ragSearch(needs.ragQuery, 15);
    const parsed = JSON.parse(data);
    if (parsed.results?.length > 0) {
      sections.push(`### Trait Search: "${needs.ragQuery}"\n${data}`);
    } else {
      sections.push(`### Trait Search: "${needs.ragQuery}" — No strong matches found`);
    }
  }

  // Structured query
  if (needs.query && Array.isArray((needs.query as any).filters)) {
    const data = queryProspects(needs.query);
    if (!data.includes('"error"')) {
      const desc = (needs.query as any).filters
        .map((f: any) => `${f.field} ${f.op} ${f.value}`)
        .join(', ');
      sections.push(`### Query: ${desc}\n${data}`);
    }
  }

  if (sections.length === 0) return 'No scouting data found for your request.';
  return sections.join('\n\n');
}

// ── Response parsing ─────────────────────────────────────────────────────

interface ResearchResponse {
  mode: 'research';
  thinking: string;
  lookups?: string[];
  posLists?: Array<{ pos: string; count: number }>;
  topN?: number;
  ragQuery?: string | null;
  query?: ProspectQuery | null;
}

interface SubmitResponse {
  mode: 'submit';
  thinking: string;
  board: string[];
}

type GMResponse = ResearchResponse | SubmitResponse;

function parseGMResponse(raw: string): GMResponse {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '').trim();

  try {
    return JSON.parse(text);
  } catch {
    // Try to extract JSON object
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch { /* fall through */ }
    }

    // Try to recover a board from truncated response
    const boardMatch = text.match(/"board"\s*:\s*\[([\s\S]*)/);
    if (boardMatch) {
      const names = [...boardMatch[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
      if (names.length > 0) {
        return { mode: 'submit', thinking: 'Recovered from truncated response', board: names };
      }
    }

    throw new Error(`Could not parse GM response: ${text.slice(0, 300)}`);
  }
}

// ── Name → rank mapping ──────────────────────────────────────────────────

function mapNamesToRanks(names: string[]): { ranks: number[]; unmatched: string[] } {
  const nameToRank = new Map<string, number>();
  for (const p of PROSPECTS) nameToRank.set(p.name.toLowerCase(), p.rank);

  const ranks: number[] = [];
  const seen = new Set<number>();
  const unmatched: string[] = [];

  for (const name of names) {
    if (typeof name !== 'string') continue;
    const lower = name.trim().toLowerCase();

    let rank = nameToRank.get(lower);

    // Without suffix
    if (rank === undefined) {
      const clean = lower.replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, '').trim();
      rank = nameToRank.get(clean);
    }

    // Partial match
    if (rank === undefined) {
      for (const [pName, pRank] of nameToRank) {
        if (pName.includes(lower) || lower.includes(pName)) {
          rank = pRank;
          break;
        }
      }
    }

    if (rank !== undefined && !seen.has(rank)) {
      ranks.push(rank);
      seen.add(rank);
    } else if (rank === undefined) {
      unmatched.push(name.trim());
    }
  }

  return { ranks, unmatched };
}

// ── Output writer ─────────────────────────────────────────────────────────

function writeOutput(boards: Record<string, number[]>, model: string): void {
  const date = new Date().toISOString().split('T')[0];
  const teamEntries = Object.entries(boards)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([team, ranks]) => {
      const chunks: string[] = [];
      for (let i = 0; i < ranks.length; i += 20) {
        chunks.push('    ' + ranks.slice(i, i + 20).join(', ') + ',');
      }
      return `  '${team}': [\n${chunks.join('\n')}\n  ]`;
    });

  const content = `/**
 * Pre-generated draft boards for AI GMs.
 * Built by scripts/generate-gm-boards.ts using multi-turn scouting conversations
 * between GM personas (wiki-based profiles) and Beast scouting data.
 *
 * Each array is an ordered list of prospect ranks (from prospects.ts).
 * Index 0 = GM's #1 overall prospect.
 *
 * Generated: ${date}
 * Model: ${model}
 * Research turns: ${researchTurns}
 */

export const GM_BOARDS: Record<string, number[]> = {
${teamEntries.join(',\n\n')},
};
`;

  fs.writeFileSync(OUTPUT_PATH, content, 'utf-8');
}

// ── Load existing boards for incremental generation ──────────────────────

function loadExistingBoards(): Record<string, number[]> {
  try {
    delete require.cache[require.resolve(OUTPUT_PATH)];
    return require(OUTPUT_PATH).GM_BOARDS ?? {};
  } catch {
    return {};
  }
}

// ── History compression ──────────────────────────────────────────────────
// Before the final board turn, replace bulky scouting data messages with
// compact summaries so the context fits comfortably and avoids cloud timeouts.

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

function compressHistory(messages: Message[]): Message[] {
  return messages.map(msg => {
    // Only compress the scouting data user messages
    if (msg.role !== 'user' || !msg.content.includes('scouting department reports')) return msg;

    // Extract section headers as a summary of what data was provided
    const headers = [...msg.content.matchAll(/^### (.+)$/gm)].map(m => m[1]);
    // Extract prospect names mentioned in scouting reports
    const names = [...msg.content.matchAll(/"name":"([^"]+)"/g)].map(m => m[1]);
    const uniqueNames = [...new Set(names)];

    const summary = [
      '[Scouting data provided — summarized for context]',
      headers.length > 0 ? `Sections: ${headers.join(', ')}` : '',
      uniqueNames.length > 0 ? `Prospects covered: ${uniqueNames.slice(0, 40).join(', ')}${uniqueNames.length > 40 ? ` (+${uniqueNames.length - 40} more)` : ''}` : '',
      // Preserve the instruction part (turns remaining, submit board, etc.)
      ...msg.content.split('\n').filter(line =>
        line.includes('research turn') || line.includes('FINAL turn') || line.includes('submit your board')
      ),
    ].filter(Boolean).join('\n');

    return { ...msg, content: summary };
  });
}

// ── Process a single team ────────────────────────────────────────────────

async function processTeam(
  client: Ollama,
  model: string,
  profile: GMProfile,
  wikiProfile: string,
  prospectList: string,
): Promise<{ ranks: number[]; unmatched: string[] } | null> {
  const gmName = getGMName(profile);
  const teamName = (TEAMS as any)[profile.team]?.name ?? profile.team;
  const systemPrompt = buildSystemPrompt(wikiProfile, gmName, profile.team);

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Here are the top 250 prospects available in the 2026 NFL Draft:\n\n${prospectList}\n\nYou have ${researchTurns} research turns. Start by evaluating your highest-priority needs. What scouting data do you need from the database?`,
    },
  ];

  if (dryRun) {
    console.log(`  System prompt: ${systemPrompt.length} chars (~${Math.round(systemPrompt.length / 4)} tokens)`);
    console.log(`  User message: ${messages[1].content.length} chars`);
    return null;
  }

  // Research turns
  for (let turn = 1; turn <= researchTurns + 1; turn++) {
    const isLastChance = turn > researchTurns;
    const turnLabel = isLastChance ? 'FINAL' : `${turn}/${researchTurns}`;

    // Compress history before final board submission to avoid cloud timeouts
    const chatMessages = isLastChance ? compressHistory(messages) : messages;
    const contextSize = chatMessages.reduce((s, m) => s + m.content.length, 0);

    console.log(`  Turn ${turnLabel}: Calling ${model}... (context: ~${Math.round(contextSize / 4)} tokens)`);
    const callStart = Date.now();

    const response = await client.chat({
      model,
      messages: chatMessages,
      format: 'json',
      options: {
        temperature: isLastChance ? 0.4 : 0.7,
        num_ctx: numCtx,
        num_predict: isLastChance ? 16384 : 4096,
      },
    });

    const elapsed = ((Date.now() - callStart) / 1000).toFixed(1);
    let parsed: GMResponse;
    try {
      parsed = parseGMResponse(response.message.content);
    } catch (err) {
      console.error(`  Turn ${turnLabel}: Parse error (${elapsed}s): ${err instanceof Error ? err.message : err}`);
      if (isLastChance) return null;
      // Inject a nudge and continue
      messages.push({ role: 'assistant', content: response.message.content });
      messages.push({ role: 'user', content: 'Your response was not valid JSON. Please respond with the correct format.' });
      continue;
    }

    // Log thinking
    if (parsed.thinking) {
      const preview = parsed.thinking.length > 200 ? parsed.thinking.slice(0, 200) + '...' : parsed.thinking;
      console.log(`  Turn ${turnLabel} (${elapsed}s): ${preview}`);
    }

    // Board submission
    if (parsed.mode === 'submit') {
      console.log(`  Board submitted with ${parsed.board.length} prospects`);
      return mapNamesToRanks(parsed.board);
    }

    // Research turn — fetch scouting data
    const research = parsed as ResearchResponse;
    const dataSummary: string[] = [];
    if (research.lookups?.length) dataSummary.push(`${research.lookups.length} lookups`);
    if (research.posLists?.length) dataSummary.push(`${research.posLists.length} pos groups`);
    if (research.topN) dataSummary.push(`top ${research.topN}`);
    if (research.ragQuery) dataSummary.push(`RAG: "${research.ragQuery}"`);
    if (research.query) dataSummary.push('structured query');
    console.log(`  Turn ${turnLabel} (${elapsed}s): Fetching ${dataSummary.join(', ') || 'nothing'}`);

    const scoutingData = await fetchScoutingData(research);
    console.log(`  Scouting data: ${Math.round(scoutingData.length / 1024)}KB`);

    // Add to conversation
    messages.push({ role: 'assistant', content: response.message.content });

    const turnsLeft = researchTurns - turn;
    const nextPrompt = turnsLeft > 0
      ? `Your scouting department reports:\n\n${scoutingData}\n\nYou have ${turnsLeft} research turn${turnsLeft > 1 ? 's' : ''} remaining. Ask more questions or submit your board when ready.`
      : `Your scouting department reports:\n\n${scoutingData}\n\nThis is your FINAL turn. You MUST now submit your board. Respond with {"mode": "submit", "thinking": "...", "board": [...]}`;

    messages.push({ role: 'user', content: nextPrompt });
  }

  console.error(`  Failed: GM never submitted a board.`);
  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL ?? 'llama3.1';
  const apiKey = process.env.OLLAMA_API_KEY;

  console.log(`Model: ${model}`);
  console.log(`Host: ${host}`);
  console.log(`Context: ${numCtx} tokens | Research turns: ${researchTurns}`);
  console.log(`Board size target: ${BOARD_SIZE} prospects`);
  if (teamFilter.size > 0) console.log(`Teams: ${[...teamFilter].join(', ')}`);
  if (dryRun) console.log('DRY RUN — prompts only, no LLM calls\n');

  // Verify Beast data is available
  const beastData = getAllProspectsRaw();
  if (beastData.length === 0) {
    console.error('ERROR: Beast scouting data not found. Ensure data/beast-scouting-compact.json exists.');
    process.exit(1);
  }
  console.log(`Beast scouting: ${beastData.length} prospects loaded`);

  // Verify wiki profiles exist
  if (!fs.existsSync(WIKI_DIR)) {
    console.error(`ERROR: Wiki profiles not found at ${WIKI_DIR}`);
    process.exit(1);
  }

  const prospectList = buildProspectList();
  const profiles = getAllGMProfiles();
  const filteredProfiles = teamFilter.size > 0
    ? profiles.filter(p => teamFilter.has(p.team))
    : profiles;

  if (filteredProfiles.length === 0) {
    console.error('No matching teams found.');
    process.exit(1);
  }

  // Check wiki profile availability
  let missingProfiles = 0;
  for (const profile of filteredProfiles) {
    const name = getGMName(profile);
    if (!loadWikiProfile(name)) {
      console.warn(`  ⚠ No wiki profile for ${name} (${profile.team})`);
      missingProfiles++;
    }
  }
  if (missingProfiles > 0) {
    console.log(`${missingProfiles} team(s) missing wiki profiles — will be skipped.\n`);
  }

  // Load existing boards for incremental updates
  const boards = teamFilter.size > 0 ? loadExistingBoards() : {};

  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const client = new Ollama({ host, headers });

  let completed = 0;
  let succeeded = 0;
  const total = filteredProfiles.length;
  const startTime = Date.now();

  for (const profile of filteredProfiles) {
    const gmName = getGMName(profile);
    const teamName = (TEAMS as any)[profile.team]?.name ?? profile.team;

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`[${completed + 1}/${total}] ${teamName} (${profile.team}) — ${gmName} — ${profile.archetype}`);
    console.log(`${'═'.repeat(70)}`);

    const wikiProfile = loadWikiProfile(gmName);
    if (!wikiProfile) {
      console.log(`  Skipped: no wiki profile found.`);
      completed++;
      continue;
    }

    const teamStart = Date.now();

    // Retry up to 2 times
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) console.log(`  Retry attempt ${attempt}...`);

        const result = await processTeam(client, model, profile, wikiProfile, prospectList);

        if (result) {
          boards[profile.team] = result.ranks;
          succeeded++;

          const elapsed = ((Date.now() - teamStart) / 1000).toFixed(0);
          console.log(`  ✅ Board: ${result.ranks.length} prospects ranked (${elapsed}s)`);
          if (result.unmatched.length > 0) {
            console.log(`  ⚠ ${result.unmatched.length} unmatched: ${result.unmatched.slice(0, 8).join(', ')}${result.unmatched.length > 8 ? '...' : ''}`);
          }

          // Show top 10
          const top10 = result.ranks.slice(0, 10).map(r => {
            const p = PROSPECTS.find(pr => pr.rank === r);
            return p ? `${p.name} (${p.pos})` : `#${r}`;
          });
          console.log(`  Top 10: ${top10.join(', ')}`);
        } else if (!dryRun) {
          console.log(`  ⚠ No board generated.`);
        }

        break; // Success or dry-run — exit retry loop
      } catch (err) {
        const elapsed = ((Date.now() - teamStart) / 1000).toFixed(0);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ Attempt ${attempt} failed (${elapsed}s): ${msg}`);
        if (attempt === 2) {
          console.error(`  Skipping ${profile.team} after 2 failures.`);
        }
      }
    }

    completed++;

    // Save after each team (incremental safety)
    if (!dryRun && Object.keys(boards).length > 0) {
      writeOutput(boards, model);
      console.log(`  💾 Saved (${Object.keys(boards).length} teams total)`);
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`Done. ${succeeded}/${completed} teams generated in ${totalElapsed}s.`);
  if (Object.keys(boards).length > 0) {
    const avgSize = Math.round(
      Object.values(boards).reduce((s, b) => s + b.length, 0) / Object.keys(boards).length
    );
    console.log(`Boards: ${Object.keys(boards).length} teams, avg ${avgSize} prospects each.`);
    console.log(`Output: ${OUTPUT_PATH}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
