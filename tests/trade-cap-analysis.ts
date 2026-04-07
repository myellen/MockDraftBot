/**
 * Analyzes the difference between our incoming cap formula and Spotrac's actual values.
 * Goal: find a pattern we can use to fix our formula.
 *
 * Usage: npx ts-node tests/trade-cap-analysis.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const fixturePath = path.join(__dirname, 'fixtures', 'spotrac-trade-tests.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

console.log('=== Incoming Cap Analysis: Our Formula vs Spotrac ===\n');
console.log('Our formula: incomingCap = max(0, capHit - deadCap)');
console.log('Spotrac uses: incomingCap = base salary (not derivable from capHit/deadCap alone)\n');
console.log('Player'.padEnd(22), 'CapHit'.padStart(12), 'DeadCap'.padStart(12),
  'Ours'.padStart(12), 'Spotrac'.padStart(12), 'Diff'.padStart(12), 'Notes');
console.log('-'.repeat(110));

for (const trade of fixture.tradeResults) {
  // Team1 sends players → team2 receives them
  for (const player of trade.team1Sends) {
    const team2Key = `team2_${trade.team2}`;
    const spotracIncoming = trade.results[team2Key]?.incomingCap ?? 0;
    // For multi-player trades, we can't split incoming per player easily
    // but for single-player sends we can
    if (trade.team1Sends.length === 1) {
      analyzePlayer(player, spotracIncoming, `→ ${trade.team2}`);
    }
  }

  for (const player of trade.team2Sends) {
    const team1Key = `team1_${trade.team1}`;
    const spotracIncoming = trade.results[team1Key]?.incomingCap ?? 0;
    if (trade.team2Sends.length === 1) {
      analyzePlayer(player, spotracIncoming, `→ ${trade.team1}`);
    }
  }
}

// Multi-player trade 6: do per-player analysis using known incoming totals
console.log('\n--- Multi-player Trade 6 (cannot split per-player) ---');
const t6 = fixture.tradeResults.find((t: any) => t.id === 6);
if (t6) {
  console.log(`  BUF sends: ${t6.team1Sends.map((p: any) => p.name).join(' + ')}`);
  console.log(`    Total incoming to DAL: $${fmt(t6.results.team2_DAL.incomingCap)}`);
  console.log(`    Sum of max(0, capHit-dead): $${fmt(
    t6.team1Sends.reduce((s: number, p: any) => s + Math.max(0, p.capHit - p.deadCap), 0)
  )}`);
  console.log(`  DAL sends: ${t6.team2Sends.map((p: any) => p.name).join(' + ')}`);
  console.log(`    Total incoming to BUF: $${fmt(t6.results.team1_BUF.incomingCap)}`);
  console.log(`    Sum of max(0, capHit-dead): $${fmt(
    t6.team2Sends.reduce((s: number, p: any) => s + Math.max(0, p.capHit - p.deadCap), 0)
  )}`);
}

function analyzePlayer(player: any, spotracIncoming: number, direction: string) {
  const ours = Math.max(0, player.capHit - player.deadCap);
  const diff = ours - spotracIncoming;
  const match = diff === 0;

  let notes = '';
  if (match) {
    notes = '✓ MATCH';
  } else if (player.deadCap === 0) {
    notes = '✓ dead=0, formula works';
  } else if (player.deadCap <= player.capHit && diff !== 0) {
    notes = `✗ dead<cap but off by ${fmt(Math.abs(diff))}`;
  } else if (player.deadCap > player.capHit) {
    notes = `✗ dead>cap, base salary=${fmt(spotracIncoming)}`;
  }

  console.log(
    `${player.name}`.padEnd(22),
    `$${fmt(player.capHit)}`.padStart(12),
    `$${fmt(player.deadCap)}`.padStart(12),
    `$${fmt(ours)}`.padStart(12),
    `$${fmt(spotracIncoming)}`.padStart(12),
    `${diff >= 0 ? '' : '-'}$${fmt(Math.abs(diff))}`.padStart(12),
    notes
  );
}

function fmt(n: number): string {
  return n.toLocaleString();
}
