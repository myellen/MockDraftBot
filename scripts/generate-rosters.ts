/**
 * Fetches current NFL rosters from the ESPN API and regenerates src/data/rosters.ts.
 *
 * Usage:
 *   npx ts-node scripts/generate-rosters.ts
 *
 * Overwrites src/data/rosters.ts in place.
 */

import * as fs from 'fs';
import * as path from 'path';

// ESPN team ID → our abbreviation
const ESPN_ID_TO_ABBR: Record<number, string> = {
  22: 'ARI', 1:  'ATL', 33: 'BAL', 2:  'BUF', 29: 'CAR',
  3:  'CHI', 4:  'CIN', 5:  'CLE', 6:  'DAL', 7:  'DEN',
  8:  'DET', 9:  'GB',  34: 'HOU', 11: 'IND', 30: 'JAX',
  12: 'KC',  13: 'LV',  24: 'LAC', 14: 'LAR', 15: 'MIA',
  16: 'MIN', 17: 'NE',  18: 'NO',  19: 'NYG', 20: 'NYJ',
  21: 'PHI', 23: 'PIT', 25: 'SF',  26: 'SEA', 27: 'TB',
  10: 'TEN', 28: 'WAS',
};

// Normalize ESPN position abbreviations to our standard set
function normalizePos(espnPos: string): string {
  switch (espnPos) {
    case 'FB':                     return 'RB';
    case 'SS': case 'FS':          return 'S';
    case 'MLB': case 'ILB':        return 'LB';
    case 'OLB':                    return 'LB';
    case 'T':                      return 'OT';
    case 'G':                      return 'OG';
    case 'NT':                     return 'DT';
    case 'SLB': case 'WLB':        return 'LB';
    case 'SAF':                    return 'S';
    default:                       return espnPos;
  }
}

// Positions we want to include (skip pure special teams)
const INCLUDE_POS = new Set([
  'QB', 'RB', 'WR', 'TE', 'OT', 'OG', 'C',
  'EDGE', 'DE', 'DT', 'LB', 'CB', 'S',
  'K', 'P', 'LS',
]);

interface EspnAthlete {
  fullName: string;
  jersey?: string;
  position?: { abbreviation: string };
}

interface EspnRosterGroup {
  athletes: EspnAthlete[];
}

interface EspnRosterResponse {
  athletes: EspnRosterGroup[];
}

async function fetchRoster(espnId: number, abbr: string): Promise<{ name: string; pos: string; number: string | null }[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${espnId}/roster`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${abbr} (id=${espnId}): HTTP ${res.status}`);
  const data = await res.json() as EspnRosterResponse;

  const players: { name: string; pos: string; number: string | null }[] = [];

  for (const group of data.athletes ?? []) {
    for (const athlete of group.athletes ?? []) {
      const rawPos = athlete.position?.abbreviation ?? '';
      const pos = normalizePos(rawPos);
      if (!INCLUDE_POS.has(pos)) continue;
      players.push({
        name:   athlete.fullName,
        pos,
        number: athlete.jersey ?? null,
      });
    }
  }

  // Sort by position group then name
  const posOrder = ['QB','RB','WR','TE','OT','OG','C','EDGE','DE','DT','LB','CB','S','K','P','LS'];
  players.sort((a, b) => {
    const pa = posOrder.indexOf(a.pos);
    const pb = posOrder.indexOf(b.pos);
    if (pa !== pb) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    return a.name.localeCompare(b.name);
  });

  return players;
}

async function main() {
  const rosters: Record<string, { name: string; pos: string; number: string | null }[]> = {};
  const ids = Object.entries(ESPN_ID_TO_ABBR) as [string, string][];

  console.error(`Fetching rosters for ${ids.length} teams...`);

  for (const [idStr, abbr] of ids.sort((a, b) => a[1].localeCompare(b[1]))) {
    const id = Number(idStr);
    process.stderr.write(`  ${abbr}... `);
    try {
      rosters[abbr] = await fetchRoster(id, abbr);
      process.stderr.write(`${rosters[abbr].length} players\n`);
    } catch (e) {
      process.stderr.write(`ERROR: ${e}\n`);
      rosters[abbr] = [];
    }
    // Small delay to be polite to the API
    await new Promise(r => setTimeout(r, 200));
  }

  // Generate TypeScript source
  const lines: string[] = [];
  lines.push('export interface RosterPlayer {');
  lines.push('  name: string;');
  lines.push('  pos: string;');
  lines.push('  number: string | null;');
  lines.push('}');
  lines.push('');
  lines.push(`// Generated ${new Date().toISOString().slice(0, 10)} via ESPN API`);
  lines.push('export const ROSTERS: Record<string, RosterPlayer[]> = {');

  for (const abbr of Object.keys(rosters).sort()) {
    lines.push(`  ${abbr}: [`);
    for (const p of rosters[abbr]) {
      const num = p.number === null ? 'null' : `"${p.number}"`;
      lines.push(`    { name: "${p.name}", pos: "${p.pos}", number: ${num} },`);
    }
    lines.push('  ],');
  }

  lines.push('};');
  lines.push('');

  const outPath = path.join(__dirname, '..', 'src', 'data', 'rosters.ts');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.error(`\nWrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
