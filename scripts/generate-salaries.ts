/**
 * Fetches NFL salary / cap-hit data and regenerates src/data/salaries.ts.
 *
 * Data sources (tried in order):
 *   1. Spotrac team pages (HTML scrape for cap hit + dead money)
 *   2. OverTheCap team pages (HTML scrape fallback)
 *
 * Usage:
 *   npx ts-node scripts/generate-salaries.ts
 *
 * Overwrites src/data/salaries.ts in place.
 */

import * as fs from 'fs';
import * as path from 'path';

interface PlayerSalaryData {
  capHit: number;      // in thousands
  deadMoney: number;   // in thousands
  baseSalary: number;  // in thousands — transferable cap (capHit minus prorated bonuses)
}

// Team abbreviation → Spotrac URL slug
const SPOTRAC_SLUGS: Record<string, string> = {
  ARI: 'arizona-cardinals', ATL: 'atlanta-falcons', BAL: 'baltimore-ravens',
  BUF: 'buffalo-bills', CAR: 'carolina-panthers', CHI: 'chicago-bears',
  CIN: 'cincinnati-bengals', CLE: 'cleveland-browns', DAL: 'dallas-cowboys',
  DEN: 'denver-broncos', DET: 'detroit-lions', GB: 'green-bay-packers',
  HOU: 'houston-texans', IND: 'indianapolis-colts', JAX: 'jacksonville-jaguars',
  KC: 'kansas-city-chiefs', LV: 'las-vegas-raiders', LAC: 'los-angeles-chargers',
  LAR: 'los-angeles-rams', MIA: 'miami-dolphins', MIN: 'minnesota-vikings',
  NE: 'new-england-patriots', NO: 'new-orleans-saints', NYG: 'new-york-giants',
  NYJ: 'new-york-jets', PHI: 'philadelphia-eagles', PIT: 'pittsburgh-steelers',
  SF: 'san-francisco-49ers', SEA: 'seattle-seahawks', TB: 'tampa-bay-buccaneers',
  TEN: 'tennessee-titans', WAS: 'washington-commanders',
};

// OTC URL slugs (same as Spotrac in most cases)
const OTC_SLUGS = SPOTRAC_SLUGS;

/**
 * Parse a dollar string like "$1,234,567" or "$12.5M" → number in thousands.
 */
function parseDollar(str: string): number {
  const cleaned = str.replace(/[$,\s]/g, '');
  if (/[Mm]$/.test(cleaned)) {
    return Math.round(parseFloat(cleaned) * 1000);
  }
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? 0 : Math.round(n / 1000);
}

/**
 * Extract player name from a table row's HTML.
 */
function extractPlayerName(row: string): string | null {
  const m = row.match(/class="[^"]*team-name[^"]*"[^>]*>([^<]+)<\/a>/i)
    ?? row.match(/<a[^>]+href="[^"]*\/nfl\/[^"]*\/[^"]*"[^>]*>([^<]+)<\/a>/i);
  const name = m?.[1]?.trim();
  return name && name.length >= 3 ? name : null;
}

/**
 * Parse a single table cell's dollar value (handles $X,XXX and ($X,XXX) and "-").
 */
function parseCellDollar(cellHtml: string): number {
  // Prefer data-sort attribute (clean numeric value, no HTML nesting issues)
  const dataSort = cellHtml.match(/data-sort="([\d.]+)"/);
  if (dataSort) return Math.round(parseFloat(dataSort[1]) / 1000);

  // Fallback: extract first dollar amount only (avoid concatenation from nested elements)
  const firstDollar = cellHtml.replace(/<[^>]*>/g, '').match(/\$[\d,]+/);
  if (!firstDollar) return 0;
  return parseDollar(firstDollar[0]);
}

/**
 * Attempt to scrape Spotrac cap table for a team's salary data.
 * Uses the cap table page which has full component breakdown per column:
 *   Player | Pos | Age | Cap Hit | Cap Hit Pct | Dead Cap | Base P5 Salary |
 *   Signing Bonus | Per Game | Roster Bonus | Option Bonus | Workout Bonus |
 *   Restructure | Incentives
 *
 * baseSalary is scraped directly from the "Base P5 Salary" column and cross-checked
 * against capHit - signingBonus - restructure.
 */
async function fetchSpotrac(slug: string, abbr: string): Promise<Record<string, PlayerSalaryData> | null> {
  const url = `https://www.spotrac.com/nfl/${slug}/cap/_/year/2026`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'MockDraftBot/1.0 (salary-data-generator)',
        'Accept': 'text/html',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();

    const players: Record<string, PlayerSalaryData> = {};

    const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    const rows = html.match(rowRegex) ?? [];

    for (const row of rows) {
      const name = extractPlayerName(row);
      if (!name) continue;

      // Extract individual <td> cells to parse by column position
      const cellRegex = /<td[^>]*>[\s\S]*?<\/td>/gi;
      const cells = row.match(cellRegex) ?? [];

      const isDeadRow = /VOIDED|TRADED|RELEASED/i.test(row);
      const key = name.toLowerCase();

      if (isDeadRow) {
        // Dead money row: first dollar amount is the dead cap charge.
        const dollarMatches = row.match(/\$[\d,]+/g);
        if (!dollarMatches) continue;
        const deadCharge = dollarMatches.map(parseDollar).find(n => n > 0) ?? 0;
        if (deadCharge <= 0) continue;
        const deadKey = players[key] ? `${key}__dead` : key;
        players[deadKey] = { capHit: deadCharge, deadMoney: deadCharge, baseSalary: 0 };
      } else if (cells.length >= 14) {
        // Full cap table row with component columns:
        //  [0]=Player [1]=Pos [2]=Age [3]=CapHit [4]=CapPct [5]=DeadCap
        //  [6]=Base [7]=Signing [8]=PerGame [9]=Roster [10]=Option
        //  [11]=Workout [12]=Restructure [13]=Incentives
        const capHit = parseCellDollar(cells[3]);
        const deadMoney = parseCellDollar(cells[5]);
        const baseSalary = parseCellDollar(cells[6]);
        const signingBonus = parseCellDollar(cells[7]);
        const restructure = parseCellDollar(cells[12]);

        if (capHit <= 0) continue;

        // The transferable cap in a trade = capHit minus prorated bonuses (signing + restructure).
        // This equals base salary + perGame + roster + option + workout + incentives.
        // We use capHit - signing - restructure because it's the most reliable formula
        // and cross-check against the scraped base salary column.
        const transferable = capHit - signingBonus - restructure;

        if (baseSalary > 0 && Math.abs(transferable - baseSalary) > 1 && transferable > baseSalary) {
          // Expected: transferable >= baseSalary (transferable includes perGame, option, etc.)
        } else if (baseSalary > transferable + 1) {
          process.stderr.write(`    [warn] ${name}: base(${baseSalary}) > transferable(${transferable})\n`);
        }

        players[key] = { capHit, deadMoney, baseSalary: transferable };
      } else {
        // Fewer columns — fall back to dollar-based parsing
        const dollarMatches = row.match(/\$[\d,]+/g);
        if (!dollarMatches || dollarMatches.length < 1) continue;
        const amounts = dollarMatches.map(parseDollar).filter(n => n > 0);
        if (amounts.length < 1) continue;
        const capHit = amounts[0];
        if (!players[key]) {
          players[key] = { capHit, deadMoney: 0, baseSalary: capHit };
        }
      }
    }

    return Object.keys(players).length > 10 ? players : null;
  } catch {
    return null;
  }
}

/**
 * Attempt to scrape OverTheCap for a team's salary data.
 */
async function fetchOTC(slug: string, abbr: string): Promise<Record<string, PlayerSalaryData> | null> {
  const url = `https://overthecap.com/salary-cap/${slug}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'MockDraftBot/1.0 (salary-data-generator)',
        'Accept': 'text/html',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();

    const players: Record<string, PlayerSalaryData> = {};

    const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    const rows = html.match(rowRegex) ?? [];

    for (const row of rows) {
      const nameMatch = row.match(/<a[^>]+href="[^"]*\/player[^"]*"[^>]*>([^<]+)<\/a>/i);
      if (!nameMatch) continue;

      const name = nameMatch[1].trim();
      if (!name || name.length < 3) continue;

      const dollarMatches = row.match(/\(?[\$][\d,]+\)?/g);
      if (!dollarMatches || dollarMatches.length < 1) continue;

      const amounts = dollarMatches.map(parseDollar).filter(n => n > 0);
      if (amounts.length < 1) continue;

      // Cap Hit is the first dollar amount in the row
      const capHit = amounts[0];
      const deadMoney = amounts.length >= 2 ? amounts[1] : Math.round(capHit * 0.4);

      // OTC doesn't have component breakdown; approximate baseSalary as capHit
      players[name.toLowerCase()] = { capHit, deadMoney, baseSalary: capHit };
    }

    return Object.keys(players).length > 10 ? players : null;
  } catch {
    return null;
  }
}

// Position-based average cap hits (in thousands) for estimation fallback
const POS_AVG_CAP: Record<string, number> = {
  QB: 15000, RB: 3500, WR: 7000, TE: 4500,
  OT: 8000, OG: 5500, C: 5000,
  EDGE: 8000, DE: 7000, DT: 6000,
  LB: 5000, CB: 6000, S: 4500,
  K: 2500, P: 2000, LS: 1200,
};

// Position-based average dead money ratio for estimation fallback
const POS_DEAD_RATIO: Record<string, number> = {
  QB: 0.50, RB: 0.30, WR: 0.40, TE: 0.35,
  OT: 0.40, OG: 0.35, C: 0.35,
  EDGE: 0.40, DE: 0.40, DT: 0.35,
  LB: 0.35, CB: 0.38, S: 0.35,
  K: 0.25, P: 0.25, LS: 0.20,
};

/**
 * Load rosters to generate position-based salary estimates as fallback.
 */
function generateEstimates(rostersPath: string): Record<string, Record<string, PlayerSalaryData>> {
  // Try to import the roster file for position data
  let rostersModule: { ROSTERS: Record<string, Array<{ name: string; pos: string; number: string | null }>> };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    rostersModule = require(rostersPath);
  } catch {
    console.error('  Could not load rosters file for estimation. Using empty salaries.');
    return {};
  }

  const result: Record<string, Record<string, PlayerSalaryData>> = {};

  for (const [abbr, players] of Object.entries(rostersModule.ROSTERS)) {
    result[abbr] = {};
    for (const player of players) {
      const baseCapHit = POS_AVG_CAP[player.pos] ?? 2000;
      // Add some variance: +/- 30% based on a deterministic hash of the name
      const hash = player.name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
      const variance = 0.7 + ((hash % 60) / 100); // 0.70 to 1.29
      const capHit = Math.round(baseCapHit * variance);
      const deadRatio = POS_DEAD_RATIO[player.pos] ?? 0.35;
      const deadMoney = Math.round(capHit * deadRatio);

      result[abbr][player.name.toLowerCase()] = { capHit, deadMoney, baseSalary: capHit };
    }
  }

  return result;
}

/**
 * Load trade machine data (ground truth for baseSalary AND deadMoney).
 * Full data: team → player → { incomingCap, deadCap } in raw dollars.
 * Falls back to legacy incoming-caps-only file if full data not found.
 */
function loadTradeMachineData(): { full: Record<string, Record<string, { incomingCap: number; deadCap: number }>>; legacy: false }
  | { full: null; legacy: Record<string, Record<string, number>> }
  | null {
  // Try full data first (has both incomingCap and deadCap)
  const fullPath = path.join(__dirname, 'trade-machine-full-data.json');
  try {
    const raw = fs.readFileSync(fullPath, 'utf8');
    return { full: JSON.parse(raw), legacy: false };
  } catch { /* fall through */ }

  // Fall back to legacy incoming-caps-only file
  const legacyPath = path.join(__dirname, 'trade-machine-incoming-caps.json');
  try {
    const raw = fs.readFileSync(legacyPath, 'utf8');
    return { full: null, legacy: JSON.parse(raw) };
  } catch {
    return null;
  }
}

// ── Name reconciliation ────────────────────────────────────────────────────
// Manual aliases for players whose Spotrac and ESPN names are completely different
const NAME_ALIASES: Record<string, string> = {
  // Format: "spotrac name (lowercase)": "ESPN roster name (lowercase)"
  // Nicknames that can't be detected automatically
  'zonovan knight': 'bam knight',
  'basil okoye': 'cj okoye',
  'sauce gardner': 'ahmad gardner',   // reverse: ESPN has Sauce, Spotrac has Ahmad
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

/** Check if two first names are plausible variants of the same name */
function firstNameMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // One is a prefix of the other (Josh/Joshua, Cam/Cameron, Pat/Patrick, Nate/Nathan, Matt/Matthew)
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 3 && longer.startsWith(shorter)) return true;
  // Common diminutives
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

function reconcileSalaryKeys(allSalaries: Record<string, Record<string, PlayerSalaryData>>): void {
  // Load roster names from rosters.ts
  const rostersFile = path.join(__dirname, '..', 'src', 'data', 'rosters.ts');
  let rosterSrc: string;
  try {
    rosterSrc = fs.readFileSync(rostersFile, 'utf-8');
  } catch {
    console.error('\nWarning: Could not read rosters.ts for name reconciliation');
    return;
  }

  // Parse roster names per team
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

  let reconciledNorm = 0;
  let reconciledLast = 0;
  let reconciledAlias = 0;

  for (const [abbr, teamSalaries] of Object.entries(allSalaries)) {
    const roster = teamRosters[abbr];
    if (!roster) continue;

    const rosterByLower = new Map(roster.map(n => [n.toLowerCase(), n]));
    const rosterByNorm = new Map(roster.map(n => [normalizeName(n), n]));

    // Build a set of salary keys that already match a roster name
    const matchedRosterKeys = new Set<string>();
    for (const salKey of Object.keys(teamSalaries)) {
      if (rosterByLower.has(salKey)) matchedRosterKeys.add(salKey);
    }

    const salKeys = Object.keys(teamSalaries);

    for (const salKey of salKeys) {
      if (rosterByLower.has(salKey)) continue; // already exact match
      if (salKey.includes('__dead')) continue;
      if (!teamSalaries[salKey]) continue; // already re-keyed in this pass

      // 1. Check manual aliases
      const alias = NAME_ALIASES[salKey];
      if (alias) {
        const rosterName = rosterByLower.get(alias);
        if (rosterName && !teamSalaries[alias]) {
          teamSalaries[alias] = teamSalaries[salKey];
          delete teamSalaries[salKey];
          reconciledAlias++;
          continue;
        }
      }

      // 2. Normalize (strip suffixes, dots)
      const normSal = normalizeName(salKey);
      const rosterMatch = rosterByNorm.get(normSal);
      if (rosterMatch) {
        const rosterKey = rosterMatch.toLowerCase();
        if (!teamSalaries[rosterKey]) {
          teamSalaries[rosterKey] = teamSalaries[salKey];
          delete teamSalaries[salKey];
          reconciledNorm++;
          continue;
        }
      }

      // 3. Last-name match with first-name validation
      const salLast = normSal.split(' ').pop()!;
      if (salLast.length < 4) continue; // skip very short last names

      const salFirst = normSal.split(' ')[0];

      // Find unmatched roster entries with same last name
      const candidates: Array<{ key: string; name: string }> = [];
      for (const [rKey, rName] of rosterByLower) {
        if (teamSalaries[rKey]) continue; // already has a salary entry
        if (matchedRosterKeys.has(rKey)) continue;
        const rNorm = normalizeName(rKey);
        if (rNorm.split(' ').pop() === salLast) {
          candidates.push({ key: rKey, name: rName });
        }
      }

      // Check for other salary keys with same last name (ambiguity)
      const salSameLast = salKeys.filter(k =>
        k !== salKey && !k.includes('__dead') && teamSalaries[k] &&
        normalizeName(k).split(' ').pop() === salLast
      );

      if (candidates.length === 1 && salSameLast.length === 0) {
        const candFirst = normalizeName(candidates[0].key).split(' ')[0];
        if (firstNameMatch(salFirst, candFirst)) {
          teamSalaries[candidates[0].key] = teamSalaries[salKey];
          delete teamSalaries[salKey];
          matchedRosterKeys.add(candidates[0].key);
          reconciledLast++;
        }
      }
    }
  }

  console.error(`\nName reconciliation: ${reconciledNorm + reconciledLast + reconciledAlias} salary entries re-keyed`);
  console.error(`  Normalization (suffix/dots): ${reconciledNorm}`);
  console.error(`  Last-name + first-name match: ${reconciledLast}`);
  console.error(`  Manual aliases: ${reconciledAlias}`);

  // Report remaining mismatches
  let remaining = 0;
  for (const [abbr, teamSalaries] of Object.entries(allSalaries)) {
    const roster = teamRosters[abbr];
    if (!roster) continue;
    const rosterSet = new Set(roster.map(n => n.toLowerCase()));
    for (const key of Object.keys(teamSalaries)) {
      if (!rosterSet.has(key) && !key.includes('__dead')) remaining++;
    }
  }
  console.error(`  Remaining unmatched: ${remaining} (legitimate dead cap / off-roster)`);
}

async function main() {
  const allSalaries: Record<string, Record<string, PlayerSalaryData>> = {};
  const teams = Object.entries(SPOTRAC_SLUGS).sort((a, b) => a[0].localeCompare(b[0]));

  console.error(`Fetching salary data for ${teams.length} teams...\n`);

  let apiSuccess = 0;

  for (const [abbr, slug] of teams) {
    process.stderr.write(`  ${abbr}... `);

    // Try Spotrac first
    let data = await fetchSpotrac(slug, abbr);
    if (data) {
      allSalaries[abbr] = data;
      process.stderr.write(`${Object.keys(data).length} players (Spotrac)\n`);
      apiSuccess++;
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    // Try OverTheCap
    data = await fetchOTC(OTC_SLUGS[abbr] ?? slug, abbr);
    if (data) {
      allSalaries[abbr] = data;
      process.stderr.write(`${Object.keys(data).length} players (OTC)\n`);
      apiSuccess++;
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    process.stderr.write('no data (will use estimates)\n');
    await new Promise(r => setTimeout(r, 300));
  }

  // ─── Override baseSalary + deadMoney with trade machine ground truth ────────
  const tmData = loadTradeMachineData();
  if (tmData) {
    let overrideCount = 0;
    let baseDiffCount = 0;
    let deadDiffCount = 0;

    if (tmData.full) {
      // Full data: override both baseSalary and deadMoney
      for (const [abbr, teamSalaries] of Object.entries(allSalaries)) {
        const tmTeam = tmData.full[abbr];
        if (!tmTeam) continue;
        const tmLookup: Record<string, { incomingCap: number; deadCap: number }> = {};
        for (const [name, val] of Object.entries(tmTeam)) {
          tmLookup[name.toLowerCase()] = val;
        }
        for (const [key, salary] of Object.entries(teamSalaries)) {
          const tm = tmLookup[key];
          if (tm === undefined) continue;
          const newBase = Math.round(tm.incomingCap / 1000);
          const newDead = Math.round(tm.deadCap / 1000);
          if (Math.abs(salary.baseSalary - newBase) > 1) baseDiffCount++;
          if (Math.abs(salary.deadMoney - newDead) > 1) deadDiffCount++;
          (salary as any).tradeIncomingCap = newBase;
          (salary as any).tradeDeadCap = newDead;
          overrideCount++;
        }
      }
      console.error(`\nTrade machine overrides (full): ${overrideCount} players matched`);
      console.error(`  baseSalary changes: ${baseDiffCount}, deadMoney changes: ${deadDiffCount}`);
    } else if (tmData.legacy) {
      // Legacy: override baseSalary only
      for (const [abbr, teamSalaries] of Object.entries(allSalaries)) {
        const tmTeam = tmData.legacy[abbr];
        if (!tmTeam) continue;
        const tmLookup: Record<string, number> = {};
        for (const [name, val] of Object.entries(tmTeam)) {
          tmLookup[name.toLowerCase()] = Math.round(val / 1000);
        }
        for (const [key, salary] of Object.entries(teamSalaries)) {
          const tmVal = tmLookup[key];
          if (tmVal !== undefined) {
            if (Math.abs(salary.baseSalary - tmVal) > 1) baseDiffCount++;
            salary.baseSalary = tmVal;
            overrideCount++;
          }
        }
      }
      console.error(`\nTrade machine overrides (legacy, baseSalary only): ${overrideCount} matched, ${baseDiffCount} changed`);
    }
  } else {
    console.error('\nNo trade machine data found (scripts/trade-machine-full-data.json or trade-machine-incoming-caps.json)');
    console.error('baseSalary values use formula: capHit - signingBonus - restructure');
  }

  // If fewer than half of teams got real data, fall back to estimates for missing teams
  const rostersPath = path.join(__dirname, '..', 'src', 'data', 'rosters');
  if (apiSuccess < teams.length) {
    console.error(`\nGenerating position-based estimates for ${teams.length - apiSuccess} teams without API data...`);
    const estimates = generateEstimates(rostersPath);
    for (const [abbr] of teams) {
      if (!allSalaries[abbr] && estimates[abbr]) {
        allSalaries[abbr] = estimates[abbr];
      }
    }
  }

  if (apiSuccess === 0) {
    console.error('\nNote: No live salary data was retrieved. All values are position-based estimates.');
    console.error('For accurate data, check that Spotrac/OTC URLs are accessible.\n');
  }

  // ── Reconcile salary keys with roster names ─────────────────────────────
  // Spotrac and ESPN use different name formats. Re-key salary entries so
  // they match the roster names used at runtime.
  reconcileSalaryKeys(allSalaries);

  // Generate TypeScript source
  const lines: string[] = [];
  lines.push("import { PlayerSalary } from '../draft/types';");
  lines.push('');
  lines.push('// 2026 NFL salary cap in thousands of dollars');
  lines.push('export const SALARY_CAP = 313450;');
  lines.push('');
  lines.push('// Rookie minimum salary in thousands (used for Rule of 51 / pick cap impact)');
  lines.push('export const ROOKIE_MINIMUM = 885;');
  lines.push('');
  lines.push('// Rookie cap hits by overall pick number (year-1 cap charge in thousands)');
  lines.push('// Based on projected 2026 rookie wage scale');
  lines.push('const ROOKIE_CAP_HITS: number[] = [');
  lines.push('  // Round 1 (picks 1-32)');
  lines.push('  12400, 11200, 10400, 9800, 9200, 8700, 8200, 7800,');
  lines.push('  7400, 7100, 6800, 6500, 6200, 6000, 5800, 5600,');
  lines.push('  5400, 5200, 5000, 4850, 4700, 4550, 4400, 4250,');
  lines.push('  4100, 3950, 3850, 3750, 3650, 3550, 3450, 3350,');
  lines.push('  // Round 2 (picks 33-64)');
  lines.push('  3250, 3150, 3050, 2950, 2850, 2800, 2750, 2700,');
  lines.push('  2650, 2600, 2550, 2500, 2450, 2400, 2350, 2300,');
  lines.push('  2250, 2200, 2150, 2100, 2050, 2000, 1975, 1950,');
  lines.push('  1925, 1900, 1875, 1850, 1825, 1800, 1775, 1750,');
  lines.push('  // Round 3 (picks 65-100)');
  lines.push('  1725, 1700, 1680, 1660, 1640, 1620, 1600, 1580,');
  lines.push('  1560, 1540, 1520, 1500, 1480, 1460, 1440, 1420,');
  lines.push('  1400, 1385, 1370, 1355, 1340, 1325, 1310, 1295,');
  lines.push('  1280, 1265, 1250, 1235, 1220, 1205, 1190, 1175,');
  lines.push('  1160, 1145, 1130, 1115,');
  lines.push('  // Rounds 4-7: league minimum');
  lines.push('];');
  lines.push('');
  lines.push('export function getRookieCapHit(overall: number): number {');
  lines.push('  if (overall <= 0) return 1000;');
  lines.push('  if (overall <= ROOKIE_CAP_HITS.length) return ROOKIE_CAP_HITS[overall - 1];');
  lines.push('  return 1000;');
  lines.push('}');
  lines.push('');
  lines.push(`// Generated ${new Date().toISOString().slice(0, 10)} via salary data script`);
  lines.push(`// Source: ${apiSuccess > 0 ? 'Spotrac / OverTheCap' : 'position-based estimates'}`);
  lines.push('export const SALARIES: Record<string, Record<string, PlayerSalary>> = {');

  for (const abbr of Object.keys(allSalaries).sort()) {
    const teamData = allSalaries[abbr];
    const entries = Object.entries(teamData).sort((a, b) => b[1].capHit - a[1].capHit);
    lines.push(`  ${/^\d/.test(abbr) ? `"${abbr}"` : abbr}: {`);
    for (const [name, salary] of entries) {
      const escapedName = name.replace(/"/g, '\\"');
      const s = salary as any;
      const extra = (s.tradeDeadCap !== undefined || s.tradeIncomingCap !== undefined)
        ? `, tradeDeadCap: ${s.tradeDeadCap ?? 0}, tradeIncomingCap: ${s.tradeIncomingCap ?? 0}`
        : '';
      lines.push(`    "${escapedName}": { capHit: ${salary.capHit}, deadMoney: ${salary.deadMoney}, baseSalary: ${salary.baseSalary}${extra} },`);
    }
    lines.push('  },');
  }

  lines.push('};');
  lines.push('');

  const outPath = path.join(__dirname, '..', 'src', 'data', 'salaries.ts');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.error(`\nWrote ${outPath}`);
  console.error(`Teams: ${Object.keys(allSalaries).length}, API data: ${apiSuccess}, Estimated: ${Object.keys(allSalaries).length - apiSuccess}`);
}

main().catch(e => { console.error(e); process.exit(1); });
