/**
 * Generates src/data/capData.ts from two sources:
 *   1. OverTheCap team overview → per-team cap space (activeSpending + deadMoney)
 *   2. scripts/trade-machine-full-data.json → per-player trade values (capHit, incomingCap, deadCap)
 *
 * Team cap space is computed as: SALARY_CAP - activeSpending - deadMoney
 * (using our $313.45M constant, not OTC's base cap which may lag the actual announced number).
 *
 * Player names are reconciled against rosters.ts to match runtime roster names.
 *
 * Usage:
 *   npx ts-node scripts/generate-cap-data.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const SALARY_CAP = 313450; // in thousands
const OTC_BASE_CAP = 301200; // OTC's assumed 2026 base cap (may lag the actual announced cap)
const CAP_ADJUSTMENT = SALARY_CAP - OTC_BASE_CAP; // added to each team's OTC cap space

// ── Team abbreviation mappings ──────────────────────────────────────────────

const OTC_TO_ABBR: Record<string, string> = {
  'titans': 'TEN', 'commanders': 'WAS', 'chargers': 'LAC', 'cardinals': 'ARI',
  'jets': 'NYJ', 'patriots': 'NE', 'eagles': 'PHI', 'seahawks': 'SEA',
  '49ers': 'SF', 'ravens': 'BAL', 'steelers': 'PIT', 'colts': 'IND',
  'rams': 'LAR', 'falcons': 'ATL', 'lions': 'DET', 'raiders': 'LV',
  'packers': 'GB', 'browns': 'CLE', 'bengals': 'CIN', 'broncos': 'DEN',
  'texans': 'HOU', 'cowboys': 'DAL', 'buccaneers': 'TB', 'saints': 'NO',
  'bills': 'BUF', 'chiefs': 'KC', 'giants': 'NYG', 'jaguars': 'JAX',
  'vikings': 'MIN', 'panthers': 'CAR', 'dolphins': 'MIA', 'bears': 'CHI',
};

// ── Name reconciliation (from generate-salaries.ts) ─────────────────────────

const NAME_ALIASES: Record<string, string> = {
  'zonovan knight': 'bam knight',
  'basil okoye': 'cj okoye',
  'sauce gardner': 'ahmad gardner',
  'ahmad gardner': 'sauce gardner',
};

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\.?\s*$/i, '')
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNameMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 3 && longer.startsWith(shorter)) return true;
  const diminutives: Record<string, string[]> = {
    'mike': ['michael'], 'michael': ['mike'],
    'chris': ['christian', 'christopher'], 'christian': ['chris'], 'christopher': ['chris'],
    'drew': ['andrew'], 'andrew': ['drew'],
    'ted': ['teddy', 'theodore', 'tedarrell'], 'tedarrell': ['ted', 'tj'],
    'tj': ['tedarrell'], 'cj': ['chauncey', 'basil'],
    'chauncey': ['cj'], 'jp': ['john'],
    'cobie': ['decobie'], 'decobie': ['cobie'],
  };
  if (diminutives[a]?.includes(b) || diminutives[b]?.includes(a)) return true;
  return false;
}

// ── OTC Scraping ────────────────────────────────────────────────────────────

function parseDollar(str: string): number {
  const cleaned = str.replace(/[$,\s]/g, '');
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? 0 : Math.round(n / 1000);
}

interface TeamCapData {
  capSpace: number;
  deadMoney: number;
}

async function fetchOTCTeamCaps(): Promise<Record<string, TeamCapData>> {
  const url = 'https://overthecap.com/salary-cap-space';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MockDraftBot/1.0', 'Accept': 'text/html' },
  });
  if (!res.ok) throw new Error(`OTC returned ${res.status}`);
  const html = await res.text();

  const result: Record<string, TeamCapData> = {};

  // Parse rows: team name, cap space, effective cap space, #, active spending, dead money
  const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const rows = html.match(rowRegex) ?? [];

  for (const row of rows) {
    // Find team abbreviation from link class (e.g. class="team-link BUF")
    const teamLink = row.match(/salary-cap\/([^/"]+)/);
    if (!teamLink) continue;

    const slug = teamLink[1].split('-').pop()?.toLowerCase() ?? '';
    const abbr = OTC_TO_ABBR[slug];
    if (!abbr) continue;
    if (result[abbr]) continue; // already found (skip 2027/2028 rows)

    // Extract dollar amounts from the row
    // Columns: Cap Space | Effective Cap Space | # | Active Cap Spending | Dead Money
    // Dollar amounts: [0]=capSpace, [1]=effectiveCapSpace, [2]=activeSpending, [3]=deadMoney
    const dollarMatches = row.match(/\$[\d,]+/g);
    if (!dollarMatches || dollarMatches.length < 4) continue;

    const amounts = dollarMatches.map(parseDollar);
    const otcCapSpace = amounts[0]; // OTC's cap space (based on their base cap)
    const deadMoney = amounts[3];   // dead money

    // Adjust cap space: OTC uses $301.2M base, we use our SALARY_CAP
    const capSpace = otcCapSpace + CAP_ADJUSTMENT;
    result[abbr] = { capSpace, deadMoney };
  }

  return result;
}

// ── Trade Machine Data Processing ───────────────────────────────────────────

interface TradePlayerRaw {
  capHit: number;
  incomingCap: number;
  deadCap: number;
}

function loadTradeMachineData(): Record<string, Record<string, TradePlayerRaw>> {
  const filePath = path.join(__dirname, 'trade-machine-full-data.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function loadRosterNames(): Record<string, string[]> {
  const rostersFile = path.join(__dirname, '..', 'src', 'data', 'rosters.ts');
  let rosterSrc: string;
  try {
    rosterSrc = fs.readFileSync(rostersFile, 'utf-8');
  } catch {
    console.error('Warning: Could not read rosters.ts for name reconciliation');
    return {};
  }

  const teamRosters: Record<string, string[]> = {};
  const teamRegex = /^\s*(\w+):\s*\[/gm;
  let match;
  while ((match = teamRegex.exec(rosterSrc))) {
    const abbr = match[1];
    const startIdx = match.index + match[0].length;
    const endIdx = rosterSrc.indexOf('],', startIdx);
    const block = rosterSrc.slice(startIdx, endIdx);
    const names: string[] = [];
    const nameRegex = /name:\s*"([^"]+)"/g;
    let nm;
    while ((nm = nameRegex.exec(block))) names.push(nm[1]);
    teamRosters[abbr] = names;
  }

  return teamRosters;
}

function reconcileNames(
  tmData: Record<string, Record<string, TradePlayerRaw>>,
  rosterNames: Record<string, string[]>
): Record<string, Record<string, { capHit: number; incomingCap: number; deadCap: number }>> {
  const result: Record<string, Record<string, { capHit: number; incomingCap: number; deadCap: number }>> = {};
  let reconNorm = 0, reconLast = 0, reconAlias = 0;

  for (const [abbr, players] of Object.entries(tmData)) {
    result[abbr] = {};
    const roster = rosterNames[abbr] ?? [];
    const rosterByLower = new Map(roster.map(n => [n.toLowerCase(), n]));
    const rosterByNorm = new Map(roster.map(n => [normalizeName(n), n]));

    for (const [playerName, values] of Object.entries(players)) {
      const key = playerName.toLowerCase();
      const entry = {
        capHit: Math.round(values.capHit / 1000),
        incomingCap: Math.round(values.incomingCap / 1000),
        deadCap: Math.round(values.deadCap / 1000),
      };

      // 1. Exact match with roster
      if (rosterByLower.has(key)) {
        result[abbr][key] = entry;
        continue;
      }

      // 2. Manual alias
      const alias = NAME_ALIASES[key];
      if (alias && rosterByLower.has(alias)) {
        result[abbr][alias] = entry;
        reconAlias++;
        continue;
      }

      // 3. Normalize (strip suffixes, dots)
      const normKey = normalizeName(key);
      const rosterMatch = rosterByNorm.get(normKey);
      if (rosterMatch) {
        result[abbr][rosterMatch.toLowerCase()] = entry;
        reconNorm++;
        continue;
      }

      // 4. Last-name match with first-name validation
      const salLast = normKey.split(' ').pop()!;
      if (salLast.length >= 4) {
        const salFirst = normKey.split(' ')[0];
        const candidates = roster.filter(rName => {
          const rNorm = normalizeName(rName);
          return rNorm.split(' ').pop() === salLast;
        });
        if (candidates.length === 1) {
          const candFirst = normalizeName(candidates[0]).split(' ')[0];
          if (firstNameMatch(salFirst, candFirst)) {
            result[abbr][candidates[0].toLowerCase()] = entry;
            reconLast++;
            continue;
          }
        }
      }

      // 5. Keep under original (lowercase) name
      result[abbr][key] = entry;
    }
  }

  console.error(`Name reconciliation: norm=${reconNorm}, last-name=${reconLast}, alias=${reconAlias}`);
  return result;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.error('Fetching team cap data from OverTheCap...');
  const teamCaps = await fetchOTCTeamCaps();
  console.error(`Got ${Object.keys(teamCaps).length} teams from OTC`);

  console.error('Loading trade machine data...');
  const tmData = loadTradeMachineData();

  console.error('Loading roster names for reconciliation...');
  const rosterNames = loadRosterNames();

  console.error('Reconciling player names...');
  const tradePlayers = reconcileNames(tmData, rosterNames);

  // Count stats
  let totalPlayers = 0, withCapHit = 0;
  for (const team of Object.values(tradePlayers)) {
    for (const p of Object.values(team)) {
      totalPlayers++;
      if (p.capHit > 0) withCapHit++;
    }
  }
  console.error(`Trade players: ${totalPlayers} total, ${withCapHit} with capHit`);

  // Generate TypeScript output
  const lines: string[] = [];
  lines.push('// Auto-generated by scripts/generate-cap-data.ts');
  lines.push(`// Generated ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('export interface TradePlayerValues {');
  lines.push('  capHit: number;       // current cap charge, in thousands');
  lines.push('  incomingCap: number;  // cap the receiving team takes on in a trade, in thousands');
  lines.push('  deadCap: number;      // dead money acceleration if traded, in thousands');
  lines.push('}');
  lines.push('');
  lines.push('// Per-team starting cap situation (from OTC, adjusted to SALARY_CAP)');
  lines.push('// Values in thousands of dollars');
  lines.push('export const TEAM_CAP: Record<string, { capSpace: number; deadMoney: number }> = {');
  for (const abbr of Object.keys(teamCaps).sort()) {
    const t = teamCaps[abbr];
    lines.push(`  ${abbr}: { capSpace: ${t.capSpace}, deadMoney: ${t.deadMoney} },`);
  }
  lines.push('};');
  lines.push('');
  lines.push('// Per-player trade values (from Spotrac trade machine + cap pages)');
  lines.push('// Keyed by team abbreviation → lowercase player name');
  lines.push('export const TRADE_PLAYERS: Record<string, Record<string, TradePlayerValues>> = {');
  for (const abbr of Object.keys(tradePlayers).sort()) {
    const teamData = tradePlayers[abbr];
    const entries = Object.entries(teamData).sort((a, b) => b[1].capHit - a[1].capHit);
    lines.push(`  ${abbr}: {`);
    for (const [name, p] of entries) {
      const escaped = name.replace(/"/g, '\\"');
      lines.push(`    "${escaped}": { capHit: ${p.capHit}, incomingCap: ${p.incomingCap}, deadCap: ${p.deadCap} },`);
    }
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');

  const outPath = path.join(__dirname, '..', 'src', 'data', 'capData.ts');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.error(`\nWrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
