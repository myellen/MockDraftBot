/**
 * Builds the redraft player pool (src/data/prospects.redraft.ts) from live
 * ESPN rosters: every current NFL player becomes a draftable "prospect" whose
 * school is his current NFL team.
 *
 * Ranking (rank = engine ID AND value ordering, so rank 1 = best redraft asset):
 *   1. CURATED_TOP — hand-ordered consensus redraft board (edit freely; names
 *      that don't match any roster are logged and skipped)
 *   2. everyone else — heuristic: position premium x contract value (capHit
 *      from capData TRADE_PLAYERS) x age curve, then capped at POOL_SIZE with
 *      a guaranteed minimum of kickers/punters so late rounds have specialists
 *
 * Usage:
 *   npm run gen-redraft
 *   npx ts-node scripts/generate-redraft-dataset.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { TEAMS } from '../src/data/teams';
import { TRADE_PLAYERS } from '../src/data/capData';

const POOL_SIZE = 600;
const MIN_KICKERS = 8;
const MIN_PUNTERS = 5;

// ESPN team ID → our abbreviation (same map as generate-rosters.ts)
const ESPN_ID_TO_ABBR: Record<number, string> = {
  22: 'ARI', 1:  'ATL', 33: 'BAL', 2:  'BUF', 29: 'CAR',
  3:  'CHI', 4:  'CIN', 5:  'CLE', 6:  'DAL', 7:  'DEN',
  8:  'DET', 9:  'GB',  34: 'HOU', 11: 'IND', 30: 'JAX',
  12: 'KC',  13: 'LV',  24: 'LAC', 14: 'LAR', 15: 'MIA',
  16: 'MIN', 17: 'NE',  18: 'NO',  19: 'NYG', 20: 'NYJ',
  21: 'PHI', 23: 'PIT', 25: 'SF',  26: 'SEA', 27: 'TB',
  10: 'TEN', 28: 'WAS',
};

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
    case 'DB':                     return 'CB';
    case 'PK':                     return 'K';
    default:                       return espnPos;
  }
}

const INCLUDE_POS = new Set([
  'QB', 'RB', 'WR', 'TE', 'OT', 'OG', 'C',
  'EDGE', 'DE', 'DT', 'LB', 'CB', 'S',
  'K', 'P', 'LS',
]);

// Roster groups to skip — practice squad and suspended players aren't
// realistic redraft assets. IR players stay in (a redraft assumes health).
const SKIP_GROUPS = new Set(['practiceSquad', 'suspended']);

interface EspnAthlete {
  fullName: string;
  jersey?: string;
  age?: number;
  experience?: { years?: number };
  position?: { abbreviation: string };
}

interface EspnRosterGroup {
  position?: string; // group name: offense | defense | specialTeam | injuredReserveOrOut | practiceSquad | suspended
  items?: EspnAthlete[];
  athletes?: EspnAthlete[];
}

interface EspnRosterResponse {
  athletes: EspnRosterGroup[];
}

interface PoolPlayer {
  name: string;
  pos: string;
  team: string;        // abbr
  age: number | null;
  expYears: number;
  capHit: number;      // thousands, 0 if unknown
  score: number;
}

async function fetchTeam(espnId: number, abbr: string): Promise<PoolPlayer[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${espnId}/roster`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${abbr} (id=${espnId}): HTTP ${res.status}`);
  const data = await res.json() as EspnRosterResponse;

  const players: PoolPlayer[] = [];
  for (const group of data.athletes ?? []) {
    if (group.position && SKIP_GROUPS.has(group.position)) continue;
    for (const athlete of (group.items ?? group.athletes ?? [])) {
      const pos = normalizePos(athlete.position?.abbreviation ?? '');
      if (!INCLUDE_POS.has(pos)) continue;
      players.push({
        name: athlete.fullName,
        pos,
        team: abbr,
        age: athlete.age ?? null,
        expYears: athlete.experience?.years ?? 0,
        capHit: 0,
        score: 0,
      });
    }
  }
  return players;
}

// ── Name matching ───────────────────────────────────────────────────────────

/** Loose key: lowercase, strip punctuation and generational suffixes. */
function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.'’\-]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Positions considered a match for curated-list disambiguation. */
const POS_COMPAT: Record<string, string[]> = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'],
  OT: ['OT', 'OG'], OG: ['OG', 'OT', 'C'], C: ['C', 'OG'],
  EDGE: ['EDGE', 'DE', 'LB'], DE: ['DE', 'EDGE', 'DT'], DT: ['DT', 'DE'],
  LB: ['LB', 'EDGE'], CB: ['CB', 'S'], S: ['S', 'CB'],
  K: ['K'], P: ['P'], LS: ['LS'],
};

function posMatches(expected: string, actual: string): boolean {
  return (POS_COMPAT[expected] ?? [expected]).includes(actual);
}

// ── Curated consensus redraft board ─────────────────────────────────────────
// Hand-ordered seed for the top of the board (contract data misranks stars on
// rookie deals, so cap value alone can't build this tier). Edit freely — the
// pos disambiguates same-named players; misses are logged, never fatal.

const CURATED_TOP: Array<{ name: string; pos: string }> = [
  // ── Tier 1: franchise QBs + generational non-QBs ──
  { name: 'Josh Allen', pos: 'QB' },
  { name: 'Lamar Jackson', pos: 'QB' },
  { name: 'Jayden Daniels', pos: 'QB' },
  { name: 'Joe Burrow', pos: 'QB' },
  { name: 'Patrick Mahomes', pos: 'QB' },
  { name: 'Ja\'Marr Chase', pos: 'WR' },
  { name: 'Justin Jefferson', pos: 'WR' },
  { name: 'Micah Parsons', pos: 'EDGE' },
  { name: 'C.J. Stroud', pos: 'QB' },
  { name: 'Jalen Hurts', pos: 'QB' },
  { name: 'Myles Garrett', pos: 'EDGE' },
  { name: 'Pat Surtain II', pos: 'CB' },
  { name: 'Justin Herbert', pos: 'QB' },
  { name: 'Penei Sewell', pos: 'OT' },
  { name: 'Sauce Gardner', pos: 'CB' },
  { name: 'CeeDee Lamb', pos: 'WR' },
  { name: 'Amon-Ra St. Brown', pos: 'WR' },
  { name: 'Puka Nacua', pos: 'WR' },
  { name: 'Malik Nabers', pos: 'WR' },
  { name: 'Bijan Robinson', pos: 'RB' },
  { name: 'Jahmyr Gibbs', pos: 'RB' },
  { name: 'Brock Bowers', pos: 'TE' },
  { name: 'Tristan Wirfs', pos: 'OT' },
  { name: 'Will Anderson Jr.', pos: 'EDGE' },
  { name: 'Maxx Crosby', pos: 'EDGE' },
  { name: 'Nick Bosa', pos: 'EDGE' },
  { name: 'Jalen Carter', pos: 'DT' },
  { name: 'Dexter Lawrence', pos: 'DT' },
  { name: 'Fred Warner', pos: 'LB' },
  { name: 'Kyle Hamilton', pos: 'S' },
  // ── Tier 2: elite vets + ascending stars ──
  { name: 'Drake Maye', pos: 'QB' },
  { name: 'Caleb Williams', pos: 'QB' },
  { name: 'Jordan Love', pos: 'QB' },
  { name: 'Bo Nix', pos: 'QB' },
  { name: 'T.J. Watt', pos: 'EDGE' },
  { name: 'Aidan Hutchinson', pos: 'EDGE' },
  { name: 'Jared Verse', pos: 'EDGE' },
  { name: 'Chris Jones', pos: 'DT' },
  { name: 'Quinnen Williams', pos: 'DT' },
  { name: 'Derek Stingley Jr.', pos: 'CB' },
  { name: 'Devon Witherspoon', pos: 'CB' },
  { name: 'Trent McDuffie', pos: 'CB' },
  { name: 'Cooper DeJean', pos: 'CB' },
  { name: 'Christian Gonzalez', pos: 'CB' },
  { name: 'Brian Branch', pos: 'S' },
  { name: 'Nico Collins', pos: 'WR' },
  { name: 'A.J. Brown', pos: 'WR' },
  { name: 'Brian Thomas Jr.', pos: 'WR' },
  { name: 'Drake London', pos: 'WR' },
  { name: 'Marvin Harrison Jr.', pos: 'WR' },
  { name: 'Garrett Wilson', pos: 'WR' },
  { name: 'Trey McBride', pos: 'TE' },
  { name: 'Sam LaPorta', pos: 'TE' },
  { name: 'Saquon Barkley', pos: 'RB' },
  { name: 'De\'Von Achane', pos: 'RB' },
  { name: 'Breece Hall', pos: 'RB' },
  { name: 'Jonathan Taylor', pos: 'RB' },
  { name: 'Christian Darrisaw', pos: 'OT' },
  { name: 'Rashawn Slater', pos: 'OT' },
  { name: 'Joe Alt', pos: 'OT' },
  { name: 'Laremy Tunsil', pos: 'OT' },
  { name: 'Christian McCaffrey', pos: 'RB' },
  { name: 'Roquan Smith', pos: 'LB' },
  { name: 'Zack Baun', pos: 'LB' },
  { name: 'Minkah Fitzpatrick', pos: 'S' },
  { name: 'Antoine Winfield Jr.', pos: 'S' },
  { name: 'Derwin James', pos: 'S' },
  { name: 'Xavier McKinney', pos: 'S' },
  { name: 'Jaylon Johnson', pos: 'CB' },
  { name: 'Denzel Ward', pos: 'CB' },
  { name: 'Marlon Humphrey', pos: 'CB' },
  { name: 'Quinyon Mitchell', pos: 'CB' },
  { name: 'DK Metcalf', pos: 'WR' },
  { name: 'Tee Higgins', pos: 'WR' },
  { name: 'DeVonta Smith', pos: 'WR' },
  { name: 'Ladd McConkey', pos: 'WR' },
  { name: 'Jaxon Smith-Njigba', pos: 'WR' },
  { name: 'George Kittle', pos: 'TE' },
  { name: 'T.J. Hockenson', pos: 'TE' },
  { name: 'Derrick Henry', pos: 'RB' },
  { name: 'Kyren Williams', pos: 'RB' },
  { name: 'Josh Jacobs', pos: 'RB' },
  { name: 'Bucky Irving', pos: 'RB' },
  { name: 'Vita Vea', pos: 'DT' },
  { name: 'Derrick Brown', pos: 'DT' },
  { name: 'Jeffery Simmons', pos: 'DT' },
  { name: 'Byron Murphy II', pos: 'DT' },
  { name: 'Mason Graham', pos: 'DT' },
  { name: 'Danielle Hunter', pos: 'EDGE' },
  { name: 'Trey Hendrickson', pos: 'EDGE' },
  { name: 'Josh Hines-Allen', pos: 'EDGE' },
  { name: 'Greg Rousseau', pos: 'EDGE' },
  { name: 'Abdul Carter', pos: 'EDGE' },
  { name: 'Jaelan Phillips', pos: 'EDGE' },
  { name: 'Brian Burns', pos: 'EDGE' },
  { name: 'Rashan Gary', pos: 'EDGE' },
  { name: 'Andrew Thomas', pos: 'OT' },
  { name: 'Jordan Mailata', pos: 'OT' },
  { name: 'Paris Johnson Jr.', pos: 'OT' },
  { name: 'Taliese Fuaga', pos: 'OT' },
  { name: 'Lane Johnson', pos: 'OT' },
  { name: 'Trent Williams', pos: 'OT' },
  { name: 'Quenton Nelson', pos: 'OG' },
  { name: 'Chris Lindstrom', pos: 'OG' },
  { name: 'Tyler Smith', pos: 'OG' },
  { name: 'Landon Dickerson', pos: 'OG' },
  { name: 'Peter Skoronski', pos: 'OG' },
  { name: 'Creed Humphrey', pos: 'C' },
  { name: 'Tyler Linderbaum', pos: 'C' },
  // ── Tier 3: quality starters / high-upside youth ──
  { name: 'Tua Tagovailoa', pos: 'QB' },
  { name: 'Baker Mayfield', pos: 'QB' },
  { name: 'Jared Goff', pos: 'QB' },
  { name: 'Dak Prescott', pos: 'QB' },
  { name: 'Brock Purdy', pos: 'QB' },
  { name: 'Kyler Murray', pos: 'QB' },
  { name: 'Trevor Lawrence', pos: 'QB' },
  { name: 'Matthew Stafford', pos: 'QB' },
  { name: 'J.J. McCarthy', pos: 'QB' },
  { name: 'Michael Penix Jr.', pos: 'QB' },
  { name: 'Bryce Young', pos: 'QB' },
  { name: 'Travis Hunter', pos: 'WR' },
  { name: 'Rome Odunze', pos: 'WR' },
  { name: 'Rashee Rice', pos: 'WR' },
  { name: 'Zay Flowers', pos: 'WR' },
  { name: 'Jordan Addison', pos: 'WR' },
  { name: 'Chris Olave', pos: 'WR' },
  { name: 'Jaylen Waddle', pos: 'WR' },
  { name: 'Terry McLaurin', pos: 'WR' },
  { name: 'Mike Evans', pos: 'WR' },
  { name: 'Davante Adams', pos: 'WR' },
  { name: 'George Pickens', pos: 'WR' },
  { name: 'DJ Moore', pos: 'WR' },
  { name: 'Jameson Williams', pos: 'WR' },
  { name: 'Xavier Worthy', pos: 'WR' },
  { name: 'Courtland Sutton', pos: 'WR' },
  { name: 'Jerry Jeudy', pos: 'WR' },
  { name: 'Ashton Jeanty', pos: 'RB' },
  { name: 'James Cook', pos: 'RB' },
  { name: 'Kenneth Walker III', pos: 'RB' },
  { name: 'Omarion Hampton', pos: 'RB' },
  { name: 'Chase Brown', pos: 'RB' },
  { name: 'Aaron Jones', pos: 'RB' },
  { name: 'Alvin Kamara', pos: 'RB' },
  { name: 'David Montgomery', pos: 'RB' },
  { name: 'Travis Etienne Jr.', pos: 'RB' },
  { name: 'TreVeyon Henderson', pos: 'RB' },
  { name: 'Quinshon Judkins', pos: 'RB' },
  { name: 'Mark Andrews', pos: 'TE' },
  { name: 'David Njoku', pos: 'TE' },
  { name: 'Travis Kelce', pos: 'TE' },
  { name: 'Kyle Pitts', pos: 'TE' },
  { name: 'Dalton Kincaid', pos: 'TE' },
  { name: 'Tucker Kraft', pos: 'TE' },
  { name: 'Jake Ferguson', pos: 'TE' },
  { name: 'Evan Engram', pos: 'TE' },
  { name: 'Dallas Goedert', pos: 'TE' },
  { name: 'Colston Loveland', pos: 'TE' },
  { name: 'Tyler Warren', pos: 'TE' },
  { name: 'Nolan Smith Jr.', pos: 'EDGE' },
  { name: 'Laiatu Latu', pos: 'EDGE' },
  { name: 'Dallas Turner', pos: 'EDGE' },
  { name: 'Mykel Williams', pos: 'EDGE' },
  { name: 'Chop Robinson', pos: 'EDGE' },
  { name: 'Kayvon Thibodeaux', pos: 'EDGE' },
  { name: 'Montez Sweat', pos: 'EDGE' },
  { name: 'Bradley Chubb', pos: 'EDGE' },
  { name: 'George Karlaftis', pos: 'EDGE' },
  { name: 'Jermaine Johnson', pos: 'EDGE' },
  { name: 'Alex Highsmith', pos: 'EDGE' },
  { name: 'Harold Landry III', pos: 'EDGE' },
  { name: 'Boye Mafe', pos: 'EDGE' },
  { name: 'Odafe Oweh', pos: 'EDGE' },
  { name: 'Kenny Clark', pos: 'DT' },
  { name: 'Zach Allen', pos: 'DE' },
  { name: 'Milton Williams', pos: 'DT' },
  { name: 'Osa Odighizuwa', pos: 'DT' },
  { name: 'Cameron Heyward', pos: 'DE' },
  { name: 'Kenneth Grant', pos: 'DT' },
  { name: 'Walter Nolen', pos: 'DT' },
  { name: 'Braden Fiske', pos: 'DT' },
  { name: 'Ed Oliver', pos: 'DT' },
  { name: 'Daron Payne', pos: 'DT' },
  { name: 'Alim McNeill', pos: 'DT' },
  { name: 'Calijah Kancey', pos: 'DT' },
  { name: 'DeForest Buckner', pos: 'DT' },
  { name: 'Leonard Williams', pos: 'DE' },
  { name: 'Nnamdi Madubuike', pos: 'DT' },
  { name: 'Dre Greenlaw', pos: 'LB' },
  { name: 'Frankie Luvu', pos: 'LB' },
  { name: 'Nick Bolton', pos: 'LB' },
  { name: 'Edgerrin Cooper', pos: 'LB' },
  { name: 'Jack Campbell', pos: 'LB' },
  { name: 'Ernest Jones IV', pos: 'LB' },
  { name: 'Zaire Franklin', pos: 'LB' },
  { name: 'Quincy Williams', pos: 'LB' },
  { name: 'Patrick Queen', pos: 'LB' },
  { name: 'Tremaine Edmunds', pos: 'LB' },
  { name: 'Demario Davis', pos: 'LB' },
  { name: 'Jaycee Horn', pos: 'CB' },
  { name: 'Joey Porter Jr.', pos: 'CB' },
  { name: 'Christian Benford', pos: 'CB' },
  { name: 'Riq Woolen', pos: 'CB' },
  { name: 'A.J. Terrell', pos: 'CB' },
  { name: 'Charvarius Ward', pos: 'CB' },
  { name: 'L\'Jarius Sneed', pos: 'CB' },
  { name: 'D.J. Reed', pos: 'CB' },
  { name: 'Paulson Adebo', pos: 'CB' },
  { name: 'Jalen Ramsey', pos: 'CB' },
  { name: 'Byron Murphy Jr.', pos: 'CB' },
  { name: 'Jessie Bates III', pos: 'S' },
  { name: 'Kerby Joseph', pos: 'S' },
  { name: 'Budda Baker', pos: 'S' },
  { name: 'Jevon Holland', pos: 'S' },
  { name: 'Grant Delpit', pos: 'S' },
  { name: 'Talanoa Hufanga', pos: 'S' },
  { name: 'Malaki Starks', pos: 'S' },
  { name: 'Nick Emmanwori', pos: 'S' },
  { name: 'Brandon Aubrey', pos: 'K' },
  { name: 'Cameron Dicker', pos: 'K' },
  { name: 'Jake Bates', pos: 'K' },
  { name: 'Chris Boswell', pos: 'K' },
];

// ── Heuristic scoring for the non-curated tail ──────────────────────────────

const POS_WEIGHT: Record<string, number> = {
  QB: 1.6, EDGE: 1.3, OT: 1.25, DE: 1.15, CB: 1.2, WR: 1.2,
  DT: 1.1, S: 1.0, TE: 1.0, LB: 1.0, OG: 1.0, C: 1.0, RB: 0.9,
  K: 0.4, P: 0.3, LS: 0.15,
};

function ageFactor(pos: string, age: number | null, expYears: number): number {
  const effAge = age ?? 22 + expYears;
  if (pos === 'QB') {
    if (effAge <= 28) return 1.1;
    if (effAge <= 32) return 0.95;
    if (effAge <= 35) return 0.8;
    return 0.6;
  }
  if (effAge <= 25) return 1.15;
  if (effAge <= 28) return 1.05;
  if (effAge <= 30) return 0.9;
  if (effAge <= 32) return 0.75;
  return 0.55;
}

function scorePlayer(p: PoolPlayer): number {
  // capHit in thousands; floor keeps min-salary and rookie-deal players in the
  // pool with a position-sensible ordering
  const value = Math.max(p.capHit, 900);
  return (POS_WEIGHT[p.pos] ?? 0.8) * value * ageFactor(p.pos, p.age, p.expYears);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const all: PoolPlayer[] = [];
  const ids = Object.entries(ESPN_ID_TO_ABBR) as [string, string][];
  console.error(`Fetching rosters for ${ids.length} teams...`);
  for (const [idStr, abbr] of ids.sort((a, b) => a[1].localeCompare(b[1]))) {
    process.stderr.write(`  ${abbr}... `);
    try {
      const players = await fetchTeam(Number(idStr), abbr);
      all.push(...players);
      process.stderr.write(`${players.length} players\n`);
    } catch (e) {
      process.stderr.write(`ERROR: ${e}\n`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.error(`Fetched ${all.length} players total`);

  // Attach capHit: player's own team first, then any team (traded players)
  const capByName = new Map<string, number>();
  for (const teamPlayers of Object.values(TRADE_PLAYERS)) {
    for (const [nameLower, vals] of Object.entries(teamPlayers)) {
      capByName.set(normName(nameLower), Math.max(capByName.get(normName(nameLower)) ?? 0, vals.capHit));
    }
  }
  // Cross-team fallback (for players traded after capData was generated) is
  // only safe when the name is unique league-wide — otherwise a fringe
  // namesake inherits a star's contract (e.g. the Browns' depth LB named
  // Justin Jefferson picking up the WR's $21M cap hit).
  const rosterNameCounts = new Map<string, number>();
  for (const p of all) {
    const k = normName(p.name);
    rosterNameCounts.set(k, (rosterNameCounts.get(k) ?? 0) + 1);
  }
  for (const p of all) {
    const own = TRADE_PLAYERS[p.team]?.[p.name.toLowerCase()];
    const uniqueName = rosterNameCounts.get(normName(p.name)) === 1;
    p.capHit = own?.capHit ?? (uniqueName ? capByName.get(normName(p.name)) ?? 0 : 0);
    p.score = scorePlayer(p);
  }

  // Curated tier: match by normalized name + compatible position
  const byNorm = new Map<string, PoolPlayer[]>();
  for (const p of all) {
    const k = normName(p.name);
    (byNorm.get(k) ?? byNorm.set(k, []).get(k)!).push(p);
  }
  const curated: PoolPlayer[] = [];
  const taken = new Set<PoolPlayer>();
  const misses: string[] = [];
  for (const c of CURATED_TOP) {
    const candidates = (byNorm.get(normName(c.name)) ?? [])
      .filter(p => !taken.has(p) && posMatches(c.pos, p.pos));
    if (candidates.length === 0) {
      misses.push(`${c.name} (${c.pos})`);
      continue;
    }
    // Prefer exact position, then highest cap hit
    candidates.sort((a, b) => (Number(b.pos === c.pos) - Number(a.pos === c.pos)) || b.capHit - a.capHit);
    // Trust the curated position over ESPN's label (ESPN calls edge rushers
    // DE/OLB and some safeties DB; the curated pos is the draft-board pos)
    candidates[0].pos = c.pos;
    curated.push(candidates[0]);
    taken.add(candidates[0]);
  }
  if (misses.length) {
    console.error(`\nCurated names not found on any roster (skipped):\n  ${misses.join('\n  ')}`);
  }

  // Heuristic tail
  const rest = all.filter(p => !taken.has(p)).sort((a, b) => b.score - a.score);
  let pool = [...curated, ...rest].slice(0, POOL_SIZE);

  // Guarantee minimum specialists (K/P) so late rounds have realistic options.
  // Collect across types first — appending inside the loop would let the next
  // type's re-slice chop off the previous type's additions.
  const specialistExtras: PoolPlayer[] = [];
  for (const [pos, min] of [['K', MIN_KICKERS], ['P', MIN_PUNTERS]] as Array<[string, number]>) {
    const have = pool.filter(p => p.pos === pos).length;
    if (have < min) {
      specialistExtras.push(...rest.filter(p => p.pos === pos && !pool.includes(p)).slice(0, min - have));
    }
  }
  if (specialistExtras.length) {
    pool = [...pool.slice(0, POOL_SIZE - specialistExtras.length), ...specialistExtras];
  }

  // Disambiguate duplicate display names with a team suffix (no parentheses —
  // DraftEngine.submitBoard strips a trailing parenthetical from input names)
  const nameCounts = new Map<string, number>();
  for (const p of pool) nameCounts.set(p.name.toLowerCase(), (nameCounts.get(p.name.toLowerCase()) ?? 0) + 1);
  const displayName = (p: PoolPlayer) =>
    (nameCounts.get(p.name.toLowerCase()) ?? 0) > 1 ? `${p.name} [${p.team}]` : p.name;

  // Emit
  const lines: string[] = [];
  lines.push(`import { Prospect } from '../engine/types';`);
  lines.push('');
  lines.push(`// Generated ${new Date().toISOString().slice(0, 10)} by scripts/generate-redraft-dataset.ts`);
  lines.push(`// League-wide redraft pool: top ${pool.length} current NFL players (ESPN rosters +`);
  lines.push(`// capData contract values + curated top board). school = current NFL team.`);
  lines.push(`export const REDRAFT_PROSPECTS: Prospect[] = [`);
  pool.forEach((p, i) => {
    const rank = i + 1;
    const name = displayName(p).replace(/'/g, "\\'");
    const school = (TEAMS[p.team]?.name ?? p.team).replace(/'/g, "\\'");
    lines.push(`  { rank: ${String(rank).padStart(3)}, name: '${name}', pos: '${p.pos}', school: '${school}' },`);
  });
  lines.push('];');
  lines.push('');

  const outPath = path.join(__dirname, '..', 'src', 'data', 'prospects.redraft.ts');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

  // Summary
  const posCounts: Record<string, number> = {};
  for (const p of pool) posCounts[p.pos] = (posCounts[p.pos] ?? 0) + 1;
  console.error(`\nWrote ${pool.length} players to ${outPath}`);
  console.error(`Curated tier: ${curated.length}/${CURATED_TOP.length} matched`);
  console.error(`Position counts: ${Object.entries(posCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  console.error(`\nTop 20:`);
  pool.slice(0, 20).forEach((p, i) =>
    console.error(`  ${i + 1}. ${displayName(p)} (${p.pos}, ${p.team}) cap=$${(p.capHit / 1000).toFixed(1)}M age=${p.age ?? '?'}`));
}

main().catch(e => { console.error(e); process.exit(1); });
