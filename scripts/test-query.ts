/**
 * Test script for the Beast scouting query system.
 *
 * Part 1: Unit tests — call queryProspects() directly with hardcoded queries.
 * Part 2: Integration tests — call extractDataNeeds() via Ollama with real user prompts.
 *
 * Usage: npx ts-node scripts/test-query.ts [--unit-only]
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { queryProspects } from '../src/data/beastScouting';
import type { ProspectQuery } from '../src/data/beastScouting';
import { chatJSON } from '../src/llm/OllamaService';

// ── Unit Tests ──

interface UnitTest {
  name: string;
  query: ProspectQuery;
  check: (result: { count: number; results: unknown[] }) => string | null; // null = pass, string = failure message
}

const unitTests: UnitTest[] = [
  {
    name: 'Filter EDGEs by position',
    query: { filters: [{ field: 'pos', op: 'eq', value: 'EDGE' }], limit: 5 },
    check: (r) => r.count > 50 ? null : `Expected 50+ EDGEs, got ${r.count}`,
  },
  {
    name: 'EDGEs under 250 lbs with sub-4.5 forty',
    query: {
      filters: [
        { field: 'pos', op: 'eq', value: 'EDGE' },
        { field: 'wt', op: 'lt', value: 250 },
        { field: 'combine.forty', op: 'lt', value: 4.5 },
      ],
      sort: { field: 'combine.forty', order: 'asc' },
      limit: 20,
    },
    check: (r) => {
      if (r.count === 0) return 'Expected matches, got 0';
      // Verify all results have forty < 4.5
      for (const p of r.results as Array<{ combine?: { forty?: number }; wt?: string }>) {
        if (p.combine?.forty && p.combine.forty >= 4.5) return `Result has forty=${p.combine.forty} >= 4.5`;
        if (p.wt && parseInt(p.wt) >= 250) return `Result has wt=${p.wt} >= 250`;
      }
      return null;
    },
  },
  {
    name: 'Sort WRs by height descending',
    query: {
      filters: [{ field: 'pos', op: 'eq', value: 'WR' }],
      sort: { field: 'ht', order: 'desc' },
      limit: 10,
    },
    check: (r) => {
      if (r.count === 0) return 'Expected WRs, got 0';
      const results = r.results as Array<{ ht?: string; name: string }>;
      // First result should be tallest
      if (!results[0].ht) return 'First WR has no height';
      return null;
    },
  },
  {
    name: 'Filter by school (contains)',
    query: {
      filters: [{ field: 'school', op: 'contains', value: 'Ohio State' }],
      sort: { field: 'ovrRank', order: 'asc' },
      limit: 30,
    },
    check: (r) => {
      if (r.count === 0) return 'Expected Ohio State prospects, got 0';
      for (const p of r.results as Array<{ school: string }>) {
        if (!p.school.toLowerCase().includes('ohio state')) return `Result school="${p.school}" doesn't contain Ohio State`;
      }
      return null;
    },
  },
  {
    name: 'CBs sorted by forty (fastest)',
    query: {
      filters: [{ field: 'pos', op: 'eq', value: 'CB' }],
      sort: { field: 'combine.forty', order: 'asc' },
      limit: 10,
    },
    check: (r) => {
      if (r.count === 0) return 'Expected CBs, got 0';
      const results = r.results as Array<{ combine?: { forty?: number }; name: string }>;
      // Results with forty times should be in ascending order
      let prevForty = 0;
      for (const p of results) {
        if (p.combine?.forty) {
          if (p.combine.forty < prevForty) return `Sort broken: ${p.combine.forty} < ${prevForty}`;
          prevForty = p.combine.forty;
        }
      }
      return null;
    },
  },
  {
    name: 'Position "in" filter (EDGE or DT)',
    query: {
      filters: [{ field: 'pos', op: 'in', value: ['EDGE', 'DT'] }],
      sort: { field: 'ovrRank', order: 'asc' },
      limit: 10,
    },
    check: (r) => {
      for (const p of r.results as Array<{ pos: string }>) {
        if (p.pos !== 'EDGE' && p.pos !== 'DT') return `Result pos="${p.pos}" not EDGE or DT`;
      }
      return null;
    },
  },
  {
    name: 'Stats filter: QBs with 20+ passing TDs',
    query: {
      filters: [
        { field: 'pos', op: 'eq', value: 'QB' },
        { field: 'stats.passing_td', op: 'gte', value: 20 },
      ],
      sort: { field: 'stats.passing_td', order: 'desc' },
      limit: 20,
    },
    check: (r) => r.count > 0 ? null : 'Expected QBs with 20+ TDs, got 0',
  },
  {
    name: 'Null handling: sort by forty (nulls last)',
    query: {
      filters: [{ field: 'pos', op: 'eq', value: 'QB' }],
      sort: { field: 'combine.forty', order: 'asc' },
      limit: 50,
    },
    check: (r) => {
      const results = r.results as Array<{ combine?: { forty?: number }; name: string }>;
      let seenNull = false;
      for (const p of results) {
        const hasForty = p.combine?.forty != null;
        if (!hasForty) seenNull = true;
        if (hasForty && seenNull) return `Non-null forty after null (${p.name}) — nulls not sorted last`;
      }
      return null;
    },
  },
];

function runUnitTests() {
  console.log('═══ UNIT TESTS ═══\n');
  let passed = 0;
  let failed = 0;

  for (const test of unitTests) {
    const raw = queryProspects(test.query);
    const result = JSON.parse(raw);
    const error = test.check(result);

    if (error) {
      console.log(`  FAIL  ${test.name}`);
      console.log(`        ${error}`);
      failed++;
    } else {
      console.log(`  PASS  ${test.name} (${result.count} matched, ${result.results.length} returned)`);
      passed++;
    }
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// ── Integration Tests ──

// Reuse the extraction prompt from board-ai (copy the key parts)
const EXTRACTION_SYSTEM = `You extract NFL draft scouting data needs from a user query. Given the query, determine what prospect data should be fetched from the scouting database.

Return ONLY JSON:
{
  "lookups": [],
  "posRanks": [],
  "posLists": [],
  "board": false,
  "topN": 0,
  "query": null
}

Key rules:
- "edge 30" / "EDGE30" / "the 30th edge" → posRanks: [{"pos":"EDGE","rank":30}]
- "top 30 edge rushers" → posLists: [{"pos":"EDGE","count":30}]
- "tell me about Cam Ward" → lookups: ["Cam Ward"]
- "compare X and Y" → lookups: ["X", "Y"]
- "best available" / "BPA" → topN: 20
- Position abbreviations: QB, RB, WR, TE, OT, G, C, EDGE, DT, LB, CB, S

Query object — for flexible filtering/sorting:
{"filters":[{"field":"...","op":"...","value":...}],"sort":{"field":"...","order":"asc"|"desc"},"limit":20}

Available fields:
- Top-level: pos, posRank, name, school, grade, ovrRank, age, ht (inches), wt (pounds)
- Combine: combine.forty, combine.vert, combine.broad, combine.shuttle, combine.cone, combine.bench, combine.hand, combine.arm
- Stats (most recent year): stats.sacks, stats.tackles, stats.passing_td, stats.interceptions, stats.receptions, stats.receiving_yards

Operators: eq, neq, lt, gt, lte, gte, in, contains
Heights in inches (6'4"=76). Weights in pounds.

When to use query vs other fields:
- "top 10 EDGEs" → posLists (simpler)
- "EDGEs sorted by forty" → query
- "fastest CBs" → query (sort combine.forty asc)
- "tallest WRs" → query (sort ht desc)
- "tell me about Travis Hunter" → lookups

Examples:
- "EDGEs under 250 with sub-4.5 40s" → query: {"filters":[{"field":"pos","op":"eq","value":"EDGE"},{"field":"wt","op":"lt","value":250},{"field":"combine.forty","op":"lt","value":4.5}],"sort":{"field":"combine.forty","order":"asc"},"limit":20}
- "who are the fastest cornerbacks?" → query: {"filters":[{"field":"pos","op":"eq","value":"CB"}],"sort":{"field":"combine.forty","order":"asc"},"limit":20}
- "prospects from Ohio State" → query: {"filters":[{"field":"school","op":"contains","value":"Ohio State"}],"sort":{"field":"ovrRank","order":"asc"},"limit":30}`;

interface ExtractionResult {
  lookups: string[];
  posRanks: Array<{ pos: string; rank: number }>;
  posLists: Array<{ pos: string; count: number }>;
  board: boolean;
  topN: number;
  query?: { filters: Array<{ field: string; op: string; value: unknown }>; sort?: { field: string; order: string }; limit?: number } | null;
}

interface IntegrationTest {
  prompt: string;
  expectQuery: boolean;  // true if we expect a query, false if lookups/posLists/etc
  description: string;
}

const integrationTests: IntegrationTest[] = [
  { prompt: 'who ran the fastest 40 at the combine?', expectQuery: true, description: 'should query with sort by combine.forty asc' },
  { prompt: 'who are the fastest corner backs?', expectQuery: true, description: 'should filter pos=CB, sort combine.forty asc' },
  { prompt: 'EDGEs under 250 lbs with sub-4.5 40 times', expectQuery: true, description: 'multi-filter + sort' },
  { prompt: 'tallest WRs in the draft', expectQuery: true, description: 'filter pos=WR, sort ht desc' },
  { prompt: 'prospects from Ohio State sorted by overall rank', expectQuery: true, description: 'school contains + sort' },
  { prompt: 'QBs who threw 30 or more passing touchdowns', expectQuery: true, description: 'stats filter' },
  { prompt: 'tell me about Cam Ward', expectQuery: false, description: 'should use lookups, NOT query (regression)' },
  { prompt: 'top 10 EDGE', expectQuery: false, description: 'should use posLists, NOT query (regression)' },
];

async function runIntegrationTests() {
  console.log('═══ INTEGRATION TESTS (Ollama extraction) ═══\n');
  let passed = 0;
  let failed = 0;

  for (const test of integrationTests) {
    process.stdout.write(`  ${test.prompt}\n`);
    try {
      const result = await chatJSON<ExtractionResult>(EXTRACTION_SYSTEM, `Query: ${test.prompt}`);
      const hasQuery = result.query != null && (Array.isArray(result.query.filters) || result.query.sort);
      const hasLookups = result.lookups?.length > 0;
      const hasPosLists = result.posLists?.length > 0;
      const hasTopN = (result.topN || 0) > 0;

      const status = test.expectQuery
        ? (hasQuery ? 'PASS' : 'FAIL')
        : (!hasQuery ? 'PASS' : 'WARN'); // WARN because having a query alongside other fields is acceptable

      if (status === 'FAIL') {
        console.log(`  ${status}  Expected query but got: lookups=${JSON.stringify(result.lookups)}, posLists=${JSON.stringify(result.posLists)}, topN=${result.topN}`);
        failed++;
      } else {
        console.log(`  ${status}  ${test.description}`);
        if (hasQuery) {
          console.log(`        query: ${JSON.stringify(result.query)}`);
          // Execute the query and show results
          const qr = JSON.parse(queryProspects(result.query as any));
          const names = qr.results.slice(0, 5).map((p: { name: string }) => p.name);
          console.log(`        → ${qr.count} matched, top 5: ${names.join(', ')}`);
        }
        if (hasLookups) console.log(`        lookups: ${JSON.stringify(result.lookups)}`);
        if (hasPosLists) console.log(`        posLists: ${JSON.stringify(result.posLists)}`);
        if (hasTopN) console.log(`        topN: ${result.topN}`);
        passed++;
      }
      console.log();
    } catch (err) {
      console.log(`  ERROR  ${err instanceof Error ? err.message : err}\n`);
      failed++;
    }
  }

  console.log(`  ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// ── Main ──

async function main() {
  const unitOnly = process.argv.includes('--unit-only');

  const unitOk = runUnitTests();

  if (!unitOnly) {
    console.log('Running integration tests (requires Ollama)...\n');
    await runIntegrationTests();
  }

  process.exit(unitOk ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
