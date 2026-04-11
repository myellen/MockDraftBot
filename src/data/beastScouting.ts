/**
 * Beast Scouting Data Service
 *
 * Loads Dane Brugler's "The Beast" scouting data and provides
 * lookup functions for use as Ollama tool calls in board-ai.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Tool } from 'ollama';

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

export function isAvailable(): boolean {
  return load().length > 0;
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
    default:
      return Promise.resolve(JSON.stringify({ error: `Unknown tool: ${name}` }));
  }
}
