/**
 * Beast Scouting Data Service
 *
 * Loads Dane Brugler's "The Beast" scouting data and provides
 * lookup functions for use as Ollama tool calls in board-ai.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Tool } from 'ollama';
import { search as ragSearchIndex, isReady as isRagReady } from '../llm/EmbeddingService';

interface CompactMeasurements {
  ht?: string;
  wt?: number;
  hand?: string;
  arm?: string;
  wing?: string;
  bench?: number | null;
  forty?: number | null;
  vert?: number | null;
  broad?: string | null;
  shuttle?: number | null;
  cone?: number | null;
}

interface CompactProspect {
  pos: string;
  posRank: number;
  name: string;
  school: string;
  grade: string;
  ovrRank: number | null;
  year?: string;
  age?: number;
  ht?: string;
  wt?: string;
  strengths?: string[];
  weaknesses?: string[];
  summary?: string;
  combine?: CompactMeasurements;
  proDayDelta?: CompactMeasurements;
  stats?: Array<Record<string, unknown>>;
}

let prospects: CompactProspect[] | null = null;

function load(): CompactProspect[] {
  if (prospects) return prospects;
  const filePath = path.join(__dirname, '..', '..', 'data', 'beast-scouting-compact.json');
  if (!fs.existsSync(filePath)) {
    console.warn('[BeastScouting] No scouting data found at', filePath);
    prospects = [];
    return prospects;
  }
  prospects = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  console.log(`[BeastScouting] Loaded ${prospects!.length} prospects`);
  return prospects!;
}

// ── Measurement parsers (internal) ──

/** Convert height string like "6'4\"" or "6'4 2/8\"" to total inches. */
function parseHeight(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = s.match(/(\d+)'(\d+)(?:\s+(\d+)\/(\d+))?/);
  if (!m) return null;
  const feet = parseInt(m[1]);
  const inches = parseInt(m[2]);
  const frac = m[3] && m[4] ? parseInt(m[3]) / parseInt(m[4]) : 0;
  return feet * 12 + inches + frac;
}

/** Convert fractional measurement string like "9 1/2", "32 3/4", "35" to decimal. */
function parseFractional(s: string | number | undefined | null): number | null {
  if (s === undefined || s === null) return null;
  if (typeof s === 'number') return s;
  const m = s.match(/(\d+)(?:\s+(\d+)\/(\d+))?/);
  if (!m) return null;
  const whole = parseInt(m[1]);
  const frac = m[2] && m[3] ? parseInt(m[2]) / parseInt(m[3]) : 0;
  return whole + frac;
}

/** Convert broad jump string like "10'09\"" or "09'07\" DN" to total inches. */
function parseBroadJump(s: string | undefined | null): number | null {
  if (!s) return null;
  // Strip trailing annotations (DN, D, numbers after closing quote)
  const cleaned = s.replace(/"\s*.*$/, '"');
  const m = cleaned.match(/(\d+)'(\d+)/);
  if (!m) return null;
  return parseInt(m[1]) * 12 + parseInt(m[2]);
}

/** Convert weight to number. Handles string "241" and number passthrough. Nulls corrupted values. */
function parseWeight(s: string | number | undefined | null): number | null {
  if (s === undefined || s === null) return null;
  if (typeof s === 'number') return s;
  const n = parseInt(s);
  if (isNaN(n) || n < 100) return null; // corrupted like "3 10"
  return n;
}

// ── Field resolver ──

const STRING_MEASUREMENT_PARSERS: Record<string, (s: string | number | undefined | null) => number | null> = {
  ht: parseHeight as (s: string | number | undefined | null) => number | null,
  hand: parseFractional,
  arm: parseFractional,
  wing: parseFractional,
  vert: parseFractional,
  broad: parseBroadJump as (s: string | number | undefined | null) => number | null,
};

/** Resolve a dot-notation field path on a prospect, auto-parsing measurement strings to numbers. */
function resolveField(p: CompactProspect, field: string): unknown {
  // Height/weight shortcuts on main prospect object
  if (field === 'ht') return parseHeight(p.ht);
  if (field === 'wt') return parseWeight(p.wt);

  // Simple top-level fields
  if (!field.includes('.')) return (p as unknown as Record<string, unknown>)[field];

  const [obj, sub] = field.split('.', 2);

  // Stats: resolve from most recent year
  if (obj === 'stats') {
    if (!p.stats || p.stats.length === 0) return undefined;
    return p.stats[p.stats.length - 1][sub];
  }

  // Combine or proDayDelta
  const measurements = obj === 'combine' ? p.combine : obj === 'proDayDelta' ? p.proDayDelta : undefined;
  if (!measurements) return undefined;

  const raw = (measurements as Record<string, unknown>)[sub];
  if (raw === undefined || raw === null) return null;

  // Auto-parse string measurement fields
  if (sub in STRING_MEASUREMENT_PARSERS && (typeof raw === 'string' || typeof raw === 'number')) {
    return STRING_MEASUREMENT_PARSERS[sub](raw as string | number);
  }
  // Weight needs special handling (can be number or corrupted string)
  if (sub === 'wt') return parseWeight(raw as string | number);

  return raw; // already numeric (forty, shuttle, cone, bench)
}

// ── Structured query system ──

export interface ProspectFilter {
  field: string;
  op: 'eq' | 'neq' | 'lt' | 'gt' | 'lte' | 'gte' | 'in' | 'contains';
  value: string | number | (string | number)[];
}

export interface ProspectQuery {
  filters: ProspectFilter[];
  sort?: { field: string; order: 'asc' | 'desc' };
  limit?: number;
}

function matchesFilter(resolved: unknown, filter: ProspectFilter): boolean {
  const { op, value } = filter;

  // Null/undefined never matches any filter
  if (resolved === undefined || resolved === null) return false;

  switch (op) {
    case 'eq':
      if (typeof resolved === 'string' && typeof value === 'string')
        return resolved.toLowerCase() === value.toLowerCase();
      return resolved === value;

    case 'neq':
      if (typeof resolved === 'string' && typeof value === 'string')
        return resolved.toLowerCase() !== value.toLowerCase();
      return resolved !== value;

    case 'lt':  return typeof resolved === 'number' && typeof value === 'number' && resolved < value;
    case 'gt':  return typeof resolved === 'number' && typeof value === 'number' && resolved > value;
    case 'lte': return typeof resolved === 'number' && typeof value === 'number' && resolved <= value;
    case 'gte': return typeof resolved === 'number' && typeof value === 'number' && resolved >= value;

    case 'in':
      if (!Array.isArray(value)) return false;
      if (typeof resolved === 'string') {
        const lower = resolved.toLowerCase();
        return value.some(v => typeof v === 'string' && v.toLowerCase() === lower);
      }
      return value.includes(resolved as string | number);

    case 'contains': {
      const needle = typeof value === 'string' ? value.toLowerCase() : String(value).toLowerCase();
      // String field: substring match
      if (typeof resolved === 'string') return resolved.toLowerCase().includes(needle);
      // Array field (strengths/weaknesses): check if any element contains the substring
      if (Array.isArray(resolved)) return resolved.some(item => typeof item === 'string' && item.toLowerCase().includes(needle));
      return false;
    }

    default: return false;
  }
}

/** Query prospects with flexible filters, sorting, and limits. */
export function queryProspects(query: ProspectQuery): string {
  const data = load();
  const limit = Math.min(query.limit || 50, 100);

  // Filter
  let results = data.filter(p =>
    query.filters.every(f => {
      const resolved = resolveField(p, f.field);
      return matchesFilter(resolved, f);
    })
  );

  // Sort
  if (query.sort) {
    const { field, order } = query.sort;
    results.sort((a, b) => {
      const va = resolveField(a, field);
      const vb = resolveField(b, field);
      // Nulls sort last regardless of order
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const cmp = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb));
      return order === 'desc' ? -cmp : cmp;
    });
  }

  const totalMatched = results.length;
  results = results.slice(0, limit);

  // Light shape (no strengths/weaknesses/summary)
  const output = results.map(p => ({
    pos: p.pos, posRank: p.posRank, name: p.name, school: p.school,
    grade: p.grade, ovrRank: p.ovrRank, ht: p.ht, wt: p.wt,
    combine: p.combine, proDayDelta: p.proDayDelta, stats: p.stats,
  }));

  return JSON.stringify({ count: totalMatched, limit, results: output });
}

export function isAvailable(): boolean {
  return load().length > 0;
}

/** Return the raw prospect array for external consumers (e.g. EmbeddingService). */
export function getAllProspectsRaw(): CompactProspect[] {
  return load();
}

/** Semantic search against scouting writeups via RAG embeddings.
 *  Optional posFilter restricts results to a specific position. */
export async function ragSearch(query: string, topK = 15, posFilter?: string): Promise<string> {
  if (!isRagReady()) {
    return JSON.stringify({ results: [], note: 'Embedding index not ready' });
  }
  const results = await ragSearchIndex(query, topK, posFilter);
  return JSON.stringify({ results });
}

/** Get all prospect names in the Beast dataset. */
export function getAllProspectNames(): string[] {
  return load().map(p => p.name);
}

/** Quick lookup: get Beast ranking info for a prospect by name. Returns null if not found. */
export function getBeastRanking(name: string): { pos: string; posRank: number; ovrRank: number | null; grade: string } | null {
  const data = load();
  const q = name.toLowerCase().trim();
  const match = data.find(p => p.name.toLowerCase() === q)
    || data.find(p => p.name.toLowerCase().includes(q));
  if (!match) return null;
  return { pos: match.pos, posRank: match.posRank, ovrRank: match.ovrRank, grade: match.grade };
}

/** Look up a single prospect by name (fuzzy match). */
export function lookupProspect(query: string): string {
  const data = load();
  const q = query.toLowerCase().trim();

  // Exact match first
  let match = data.find(p => p.name.toLowerCase() === q);

  // Partial match
  if (!match) {
    match = data.find(p => p.name.toLowerCase().includes(q));
  }

  // Last name match
  if (!match) {
    match = data.find(p => {
      const lastName = p.name.split(' ').pop()?.toLowerCase();
      return lastName === q;
    });
  }

  if (!match) return JSON.stringify({ error: `No prospect found matching "${query}"` });

  return JSON.stringify(match);
}

/** Look up a prospect by name, returning only measurements + basic info (no writeup text). */
export function lookupProspectLight(query: string): string {
  const data = load();
  const q = query.toLowerCase().trim();
  const match = data.find(p => p.name.toLowerCase() === q)
    || data.find(p => p.name.toLowerCase().includes(q));
  if (!match) return JSON.stringify({ error: `No prospect found matching "${query}"` });
  return JSON.stringify({
    name: match.name, pos: match.pos, posRank: match.posRank, school: match.school,
    grade: match.grade, ovrRank: match.ovrRank, ht: match.ht, wt: match.wt,
    combine: match.combine, proDayDelta: match.proDayDelta, stats: match.stats,
  });
}

/** Look up a prospect by position and position rank (e.g. EDGE 30). */
export function lookupByPositionRank(position: string, rank: number): string {
  const data = load();
  const pos = position.toUpperCase().trim();
  const match = data.find(p => p.pos === pos && p.posRank === rank);
  if (!match) return JSON.stringify({ error: `No ${pos} prospect at rank ${rank}` });
  return JSON.stringify(match);
}

/** Search prospects by position, returning top N by position rank. */
export function searchByPosition(position: string, count: number = 10): string {
  const data = load();
  const pos = position.toUpperCase().trim();
  const matches = data
    .filter(p => p.pos === pos)
    .sort((a, b) => a.posRank - b.posRank)
    .slice(0, count);

  if (!matches.length) return JSON.stringify({ error: `No prospects found for position "${position}"` });

  // Include measurements + stats (enables follow-up comparisons) but omit text writeups
  const detailed = matches.map(p => ({
    pos: p.pos,
    posRank: p.posRank,
    name: p.name,
    school: p.school,
    grade: p.grade,
    ovrRank: p.ovrRank,
    ht: p.ht,
    wt: p.wt,
    combine: p.combine,
    proDayDelta: p.proDayDelta,
    stats: p.stats,
    strengthCount: p.strengths?.length ?? 0,
    weaknessCount: p.weaknesses?.length ?? 0,
  }));

  return JSON.stringify(detailed);
}

/** Compare two prospects side-by-side. */
export function compareProspects(name1: string, name2: string): string {
  const data = load();
  const find = (q: string) => {
    const lower = q.toLowerCase().trim();
    return data.find(p => p.name.toLowerCase() === lower)
      || data.find(p => p.name.toLowerCase().includes(lower));
  };

  const p1 = find(name1);
  const p2 = find(name2);

  if (!p1 && !p2) return JSON.stringify({ error: `Neither "${name1}" nor "${name2}" found` });
  if (!p1) return JSON.stringify({ error: `"${name1}" not found`, found: p2 });
  if (!p2) return JSON.stringify({ error: `"${name2}" not found`, found: p1 });

  return JSON.stringify({ prospect1: p1, prospect2: p2 });
}

/** Get the top N prospects overall (by overall rank, then position rank). */
export function getTopProspects(count: number = 20): string {
  const data = load();
  const sorted = [...data].sort((a, b) => {
    if (a.ovrRank && b.ovrRank) return a.ovrRank - b.ovrRank;
    if (a.ovrRank) return -1;
    if (b.ovrRank) return 1;
    return a.posRank - b.posRank;
  }).slice(0, count);

  const detailed = sorted.map(p => ({
    pos: p.pos,
    posRank: p.posRank,
    name: p.name,
    school: p.school,
    grade: p.grade,
    ovrRank: p.ovrRank,
    ht: p.ht,
    wt: p.wt,
    combine: p.combine,
    proDayDelta: p.proDayDelta,
    stats: p.stats,
  }));

  return JSON.stringify(detailed);
}

/** Ollama tool definitions for Beast scouting data. */
export const BEAST_TOOLS: Tool[] = [
  {
    type: 'function',
    function: {
      name: 'lookup_prospect',
      description: 'Look up detailed scouting report for a specific NFL draft prospect by name. Returns strengths, weaknesses, summary, measurements, grade, and stats from Dane Brugler\'s Beast guide.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The prospect name to look up (e.g. "Travis Hunter", "Cam Ward", "Abdul Carter")',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_position',
      description: 'Get ranked list of prospects at a specific position. Returns names, schools, grades, and overall ranks.',
      parameters: {
        type: 'object',
        properties: {
          position: {
            type: 'string',
            description: 'Position abbreviation: QB, RB, WR, TE, OT, G, C, EDGE, DT, LB, CB, S',
          },
          count: {
            type: 'number',
            description: 'Number of prospects to return (default 10, max 30)',
          },
        },
        required: ['position'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_prospects',
      description: 'Compare two prospects side-by-side with full scouting data for both.',
      parameters: {
        type: 'object',
        properties: {
          name1: { type: 'string', description: 'First prospect name' },
          name2: { type: 'string', description: 'Second prospect name' },
        },
        required: ['name1', 'name2'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_top_prospects',
      description: 'Get the top-ranked prospects overall across all positions.',
      parameters: {
        type: 'object',
        properties: {
          count: {
            type: 'number',
            description: 'Number of top prospects to return (default 20, max 50)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_prospects',
      description: 'Query the scouting database with flexible filters, sorting, and limit. Use for filtered/sorted searches like "EDGEs under 250 with sub-4.5 forties sorted by forty time".',
      parameters: {
        type: 'object',
        properties: {
          filters: {
            type: 'string',
            description: 'JSON array of filter objects [{field, op, value}]. Fields: pos, wt, ht, age, ovrRank, combine.forty, combine.vert, combine.shuttle, combine.cone, combine.bench, combine.hand, combine.arm, stats.sacks, stats.passing_td. Ops: eq, neq, lt, gt, lte, gte, in, contains. Heights in inches (6\'4"=76), weights in pounds.',
          },
          sort_field: { type: 'string', description: 'Field to sort by' },
          sort_order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction' },
          limit: { type: 'number', description: 'Max results (default 50, max 100)' },
        },
        required: ['filters'],
      },
    },
  },
];

/** Handle a tool call by name. Used as the ToolHandler for chatWithTools. */
export function handleBeastTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'lookup_prospect':
      return Promise.resolve(lookupProspect(args.name as string));
    case 'search_position':
      return Promise.resolve(searchByPosition(args.position as string, Math.min((args.count as number) || 10, 30)));
    case 'compare_prospects':
      return Promise.resolve(compareProspects(args.name1 as string, args.name2 as string));
    case 'get_top_prospects':
      return Promise.resolve(getTopProspects(Math.min((args.count as number) || 20, 50)));
    case 'query_prospects': {
      const filters = typeof args.filters === 'string' ? JSON.parse(args.filters) : args.filters;
      return Promise.resolve(queryProspects({
        filters: Array.isArray(filters) ? filters : [],
        sort: args.sort_field ? { field: args.sort_field as string, order: (args.sort_order as 'asc' | 'desc') || 'asc' } : undefined,
        limit: Math.min((args.limit as number) || 50, 100),
      }));
    }
    default:
      return Promise.resolve(JSON.stringify({ error: `Unknown tool: ${name}` }));
  }
}
