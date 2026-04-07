/**
 * Validates trade cap calculations against Spotrac trade machine results.
 *
 * Two layers of validation:
 *   1. baseSalary accuracy: our baseSalary values match Spotrac's incoming cap (ground truth)
 *   2. TradeManager integration: calculateTradeCapImpact produces self-consistent results
 *
 * Usage: npx ts-node tests/trade-cap-validation.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { TradeManager, TradeManagerHost } from '../src/draft/TradeManager';
import { DraftState, PendingTrade } from '../src/draft/types';
import { SALARIES } from '../src/data/salaries';

// ─── Fixture types ──────────────────────────────────────────────────────────

interface TradePlayer {
  name: string;
  pos: string;
  capHit: number;   // from Spotrac trade machine (raw dollars)
  deadCap: number;  // from Spotrac trade machine (raw dollars)
}

interface TradeResult {
  incomingCap: number;
  retainedDead: number;
  afterTrade: number;
  originalCap: number;
  netCap: number;
}

interface TradeTest {
  id: number;
  description: string;
  team1: string;
  team2: string;
  team1Sends: TradePlayer[];
  team2Sends: TradePlayer[];
  team1SendsPicks?: string[];
  team2SendsPicks?: string[];
  results: { [key: string]: TradeResult };
}

interface FixtureData {
  tradeResults: TradeTest[];
}

// ─── Minimal TradeManager for integration tests ─────────────────────────────

function createTradeManager(): TradeManager {
  const state: DraftState = {
    schemaVersion: 1,
    status: 'active',
    config: {
      channelId: null,
      timerSeconds: null,
      autoPick: false,
      rounds: 7,
      allowPlayerTrades: true,
      tradeAnnouncement: 'private',
      enforceSalaryCap: true,
    },
    assignments: {},
    coManagers: {},
    schedule: [],
    currentPickIndex: 0,
    picks: [],
    availableRanks: [],
    timerExpiresAt: null,
    pendingTrades: [],
    tradeHistory: [],
    playerOwnership: {},
    futurePickRights: [],
  };

  const host: TradeManagerHost = {
    persist: async () => {},
    sendEmbed: async () => {},
    getUserTeam: () => null,
    isAuthorizedForTeam: () => false,
    resolvePlayer: () => null,
    clearTimer: () => {},
    refreshClock: async () => {},
  };

  return new TradeManager(state, host);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function lookupBaseSalary(playerName: string): number {
  const key = playerName.toLowerCase();
  for (const [, teamSalaries] of Object.entries(SALARIES)) {
    if (teamSalaries[key]) return teamSalaries[key].baseSalary * 1000; // thousands → raw dollars
  }
  return 0;
}

function lookupSalary(playerName: string): { capHit: number; deadMoney: number; baseSalary: number } | null {
  const key = playerName.toLowerCase();
  for (const [, teamSalaries] of Object.entries(SALARIES)) {
    if (teamSalaries[key]) return teamSalaries[key];
  }
  return null;
}

function fmt(n: number): string {
  if (n === 0) return '$0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs}`;
}

// ─── Run validation ──────────────────────────────────────────────────────────

const fixturePath = path.join(__dirname, 'fixtures', 'spotrac-trade-tests.json');
const fixture: FixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const tm = createTradeManager();

let passed = 0;
let failed = 0;
let total = 0;

console.log('=== Trade Cap Validation ===\n');

for (const trade of fixture.tradeResults) {
  console.log(`─── Trade ${trade.id}: ${trade.description} ───`);

  const team1Key = `team1_${trade.team1}`;
  const team2Key = `team2_${trade.team2}`;
  const expected1 = trade.results[team1Key];
  const expected2 = trade.results[team2Key];

  if (!expected1 || !expected2) {
    console.log('  SKIP: missing expected results\n');
    continue;
  }

  // Picks-only trades: no player cap impact
  if (trade.team1Sends.length === 0 && trade.team2Sends.length === 0) {
    console.log('  Picks-only trade — no player cap impact to validate.');
    const pass = expected1.netCap === 0 && expected2.netCap === 0;
    console.log(`  Result: ${pass ? 'PASS ✓' : 'FAIL ✗'}\n`);
    if (pass) passed++; else failed++;
    total++;
    continue;
  }

  // ── Part 1: baseSalary accuracy (fixture capHit/deadCap + our baseSalary vs Spotrac) ──

  let ourTeam1RetainedDead = 0, ourTeam1IncomingCap = 0;
  let ourTeam2RetainedDead = 0, ourTeam2IncomingCap = 0;

  for (const player of trade.team1Sends) {
    ourTeam1RetainedDead += player.deadCap;
    ourTeam2IncomingCap += lookupBaseSalary(player.name);
  }
  for (const player of trade.team2Sends) {
    ourTeam2RetainedDead += player.deadCap;
    ourTeam1IncomingCap += lookupBaseSalary(player.name);
  }

  const ourTeam1AfterTrade = ourTeam1IncomingCap + ourTeam1RetainedDead;
  const ourTeam2AfterTrade = ourTeam2IncomingCap + ourTeam2RetainedDead;
  const team1OriginalCap = trade.team1Sends.reduce((s, p) => s + p.capHit, 0);
  const team2OriginalCap = trade.team2Sends.reduce((s, p) => s + p.capHit, 0);
  const ourTeam1NetCap = -(ourTeam1AfterTrade - team1OriginalCap);
  const ourTeam2NetCap = -(ourTeam2AfterTrade - team2OriginalCap);

  const formulaChecks = [
    { label: `${trade.team1} retainedDead`, ours: ourTeam1RetainedDead, expected: expected1.retainedDead },
    { label: `${trade.team1} incomingCap`,  ours: ourTeam1IncomingCap,  expected: expected1.incomingCap },
    { label: `${trade.team1} afterTrade`,   ours: ourTeam1AfterTrade,   expected: expected1.afterTrade },
    { label: `${trade.team1} originalCap`,  ours: team1OriginalCap,     expected: expected1.originalCap },
    { label: `${trade.team1} netCap`,       ours: ourTeam1NetCap,       expected: expected1.netCap },
    { label: `${trade.team2} retainedDead`, ours: ourTeam2RetainedDead, expected: expected2.retainedDead },
    { label: `${trade.team2} incomingCap`,  ours: ourTeam2IncomingCap,  expected: expected2.incomingCap },
    { label: `${trade.team2} afterTrade`,   ours: ourTeam2AfterTrade,   expected: expected2.afterTrade },
    { label: `${trade.team2} originalCap`,  ours: team2OriginalCap,     expected: expected2.originalCap },
    { label: `${trade.team2} netCap`,       ours: ourTeam2NetCap,       expected: expected2.netCap },
  ];

  let allPass = true;
  for (const check of formulaChecks) {
    total++;
    if (Math.abs(check.ours - check.expected) <= 1000) {
      passed++;
    } else {
      failed++;
      allPass = false;
      console.log(`  FAIL ✗ ${check.label}: ours=${fmt(check.ours)}, expected=${fmt(check.expected)}, diff=${fmt(check.ours - check.expected)}`);
    }
  }

  // ── Part 2: TradeManager integration (code path produces self-consistent results) ──

  const pendingTrade: PendingTrade = {
    id: `TEST-${trade.id}`,
    proposerUserId: 'test',
    proposerTeam: trade.team1,
    receiverUserId: 'test',
    receiverTeam: trade.team2,
    offeredOveralls: [],
    requestedOveralls: [],
    offeredPlayers: trade.team1Sends.map(p => p.name),
    requestedPlayers: trade.team2Sends.map(p => p.name),
    offeredFuturePicks: [],
    requestedFuturePicks: [],
    createdAt: Date.now(),
    expiresAt: Date.now() + 86400000,
  };

  const impact = tm.calculateTradeCapImpact(pendingTrade);

  // Manually compute expected cap deltas from the same SALARIES data TradeManager uses
  let expectedProposerDelta = 0;
  let expectedReceiverDelta = 0;

  for (const player of trade.team1Sends) {
    const sal = lookupSalary(player.name);
    if (!sal) continue;
    // Proposer (team1) sends player → deadMoney - capHit delta; receiver takes on baseSalary
    expectedProposerDelta += sal.deadMoney - sal.capHit;
    expectedReceiverDelta -= sal.baseSalary;
  }
  for (const player of trade.team2Sends) {
    const sal = lookupSalary(player.name);
    if (!sal) continue;
    expectedReceiverDelta += sal.deadMoney - sal.capHit;
    expectedProposerDelta -= sal.baseSalary;
  }

  const tmChecks = [
    { label: `${trade.team1} TM.proposerCapChange`, ours: impact.proposerCapChange, expected: expectedProposerDelta },
    { label: `${trade.team2} TM.receiverCapChange`, ours: impact.receiverCapChange, expected: expectedReceiverDelta },
  ];

  for (const check of tmChecks) {
    total++;
    if (Math.abs(check.ours - check.expected) <= 1) {
      passed++;
    } else {
      failed++;
      allPass = false;
      console.log(`  FAIL ✗ ${check.label}: TM=${check.ours}, expected=${check.expected}`);
    }
  }

  // Also verify validateTradeCap returns warnings array
  const validation = tm.validateTradeCap(pendingTrade);
  total++;
  if (Array.isArray(validation.warnings)) {
    passed++;
  } else {
    failed++;
    allPass = false;
    console.log(`  FAIL ✗ validateTradeCap missing warnings array`);
  }

  if (allPass) {
    console.log(`  ALL PASS ✓`);
  }
  console.log('');
}

console.log(`\n=== Summary ===`);
console.log(`Total checks: ${total}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Pass rate: ${((passed / total) * 100).toFixed(1)}%`);

if (failed > 0) {
  process.exit(1);
}
