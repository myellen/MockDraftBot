/**
 * Process agent board outputs into gmBoards.ts
 * Reads agent output text, extracts ===BOARD=== sections, maps names to prospect ranks.
 *
 * Usage: npx ts-node scripts/process-agent-boards.ts <output-dir-or-file>
 */

import { PROSPECTS } from '../src/data/prospects';

// Build name lookup maps
const exactMap = new Map<string, number>();
const lowerMap = new Map<string, number>();
for (const p of PROSPECTS) {
  exactMap.set(p.name, p.rank);
  lowerMap.set(p.name.toLowerCase(), p.rank);
}

function mapNameToRank(name: string): number | null {
  // Exact match
  const exact = exactMap.get(name);
  if (exact !== undefined) return exact;

  // Case-insensitive exact
  const lower = lowerMap.get(name.toLowerCase());
  if (lower !== undefined) return lower;

  const nameLow = name.toLowerCase().trim();

  // Strip common suffixes and retry
  const stripped = nameLow
    .replace(/\s*(jr\.?|sr\.?|ii|iii|iv)$/i, '')
    .trim();
  if (stripped !== nameLow) {
    for (const p of PROSPECTS) {
      const pStripped = p.name.toLowerCase().replace(/\s*(jr\.?|sr\.?|ii|iii|iv)$/i, '').trim();
      if (pStripped === stripped) return p.rank;
    }
  }

  // Partial match: prospect name contains input or input contains prospect name
  for (const p of PROSPECTS) {
    const pLow = p.name.toLowerCase();
    if (pLow.includes(nameLow) || nameLow.includes(pLow)) return p.rank;
  }

  // Last name match (risky but catches edge cases)
  const parts = nameLow.split(/\s+/);
  const lastName = parts[parts.length - 1];
  if (lastName.length >= 4) {
    const matches = PROSPECTS.filter(p =>
      p.name.toLowerCase().split(/\s+/).pop() === lastName
    );
    if (matches.length === 1) return matches[0].rank;
  }

  return null;
}

export function extractBoard(text: string): string[] | null {
  // Try ===BOARD=== format
  const boardMatch = text.match(/===BOARD===\s*\n?([\s\S]*?)\n?\s*===END===/);
  if (boardMatch) {
    try {
      // The content might be a JSON array or might span multiple lines
      let content = boardMatch[1].trim();
      // Handle multi-line JSON arrays
      if (content.startsWith('[')) {
        return JSON.parse(content) as string[];
      }
    } catch {
      // Try to extract names line by line
      const lines = boardMatch[1].trim().split('\n')
        .map(l => l.trim().replace(/^[\d]+\.\s*/, '').replace(/["',]/g, '').trim())
        .filter(l => l.length > 0);
      if (lines.length > 10) return lines;
    }
  }

  // Fallback: try to find any JSON array that looks like a board
  const jsonMatch = text.match(/\[[\s\S]*?"[A-Z][\s\S]*?\]/g);
  if (jsonMatch) {
    // Pick the longest array (most likely the full board)
    let best: string[] = [];
    for (const m of jsonMatch) {
      try {
        const arr = JSON.parse(m) as string[];
        if (Array.isArray(arr) && arr.length > best.length && arr.every(x => typeof x === 'string')) {
          best = arr;
        }
      } catch { /* skip */ }
    }
    if (best.length > 10) return best;
  }

  return null;
}

export function processBoard(names: string[]): { ranks: number[]; unmatched: string[] } {
  const ranks: number[] = [];
  const unmatched: string[] = [];
  const seen = new Set<number>();

  for (const name of names) {
    const rank = mapNameToRank(name);
    if (rank !== null && !seen.has(rank)) {
      ranks.push(rank);
      seen.add(rank);
    } else if (rank === null) {
      unmatched.push(name);
    }
    // Skip duplicates silently
  }

  return { ranks, unmatched };
}

// CLI entry point
if (require.main === module) {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: npx ts-node scripts/process-agent-boards.ts <text>');
    process.exit(1);
  }

  const names = extractBoard(input);
  if (!names) {
    console.error('Could not extract board from input');
    process.exit(1);
  }

  const { ranks, unmatched } = processBoard(names);
  console.log(JSON.stringify({ ranks, unmatched, total: names.length, matched: ranks.length }));
}
