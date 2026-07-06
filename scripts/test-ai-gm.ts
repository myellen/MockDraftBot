/**
 * Headless test harness for AI GM trading.
 *
 * Runs without Discord — tests the LLM trade evaluation, trade idea generation,
 * on-clock decisions, GM profiles, and value charts in isolation.
 *
 * Usage: npx ts-node scripts/test-ai-gm.ts [--no-llm]
 *
 * --no-llm  Skip LLM tests (only run unit tests for value charts + profiles)
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { getPickValue, getFuturePickValue, evaluateTradeValue, isTradeReasonable, getValueChartPrompt, type ValueChartType } from '../src/draft/tradeValue';
import { getGMProfile, getAllGMProfiles } from '../src/data/gmProfiles';
import { TEAMS } from '../src/data/teams';
import { isOllamaConfigured } from '../src/llm/OllamaService';
import { evaluateIncomingTrade, generateTradeIdea, decideOnClockTrade, type TradeAIContext } from '../src/llm/TradeAI';

const skipLLM = process.argv.includes('--no-llm');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

// ── Value Chart Tests ───────────────────────────────────────────────────────

function testValueCharts(): void {
  console.log('\n📊 Value Chart Tests\n');

  // Pick #1 should be the most valuable
  assert(getPickValue(1) === 3000, 'Pick #1 standard = 3000');
  assert(getPickValue(224) === 10, 'Pick #224 standard = 10');

  // Interpolation works
  const pick41 = getPickValue(41);
  assert(pick41 > getPickValue(45) && pick41 < getPickValue(40), `Pick #41 interpolated = ${pick41} (between 40 and 45)`);

  // Analytics devalues top picks
  assert(getPickValue(1, 'analytics') < getPickValue(1, 'standard'), `Analytics #1 (${getPickValue(1, 'analytics')}) < Standard #1 (${getPickValue(1, 'standard')})`);

  // Old school overvalues top picks
  assert(getPickValue(1, 'old_school') > getPickValue(1, 'standard'), `Old school #1 (${getPickValue(1, 'old_school')}) > Standard #1 (${getPickValue(1, 'standard')})`);

  // Future picks discount
  const currentYear = new Date().getFullYear();
  const r1Now = getFuturePickValue(currentYear, 1);
  const r1Next = getFuturePickValue(currentYear + 1, 1);
  assert(r1Next < r1Now, `Next year R1 (${r1Next}) < This year R1 (${r1Now})`);
  assert(r1Next === Math.round(r1Now * 0.85), 'Next year = 85% of this year');

  // Trade reasonableness
  assert(isTradeReasonable([1], [32, 33, 64]), 'Pick 1 for 32+33+64 = reasonable');
  assert(!isTradeReasonable([1], [200]), 'Pick 1 for 200 = unreasonable');
  assert(isTradeReasonable([1], [2]), 'Pick 1 for 2 = reasonable');
  assert(isTradeReasonable([], [], [{ year: currentYear + 1, round: 2 }], [{ year: currentYear + 1, round: 3 }]),
    'Future R2 for future R3 = reasonable');

  // Evaluate trade value
  const eval1 = evaluateTradeValue(
    { overalls: [10] },
    { overalls: [20, 50] },
    'standard',
    () => null,
  );
  assert(eval1.givingValue > 0 && eval1.receivingValue > 0, `Trade eval: giving=${eval1.givingValue}, receiving=${eval1.receivingValue}, ratio=${eval1.ratio.toFixed(2)}`);

  // Chart prompt generation
  for (const chart of ['standard', 'analytics', 'old_school', 'aggressive'] as ValueChartType[]) {
    const prompt = getValueChartPrompt(chart);
    assert(prompt.includes('Pick 1:'), `${chart} prompt includes pick values`);
  }
}

// ── GM Profile Tests ────────────────────────────────────────────────────────

function testGMProfiles(): void {
  console.log('\n🎭 GM Profile Tests\n');

  const profiles = getAllGMProfiles();
  const teamAbbrs = Object.keys(TEAMS);

  // Every defined profile maps to a real team
  for (const p of profiles) {
    assert(!!TEAMS[p.team], `Profile ${p.team} maps to a real team`);
  }

  // Every team should get a profile (fallback is fine)
  for (const abbr of teamAbbrs) {
    const profile = getGMProfile(abbr);
    assert(profile.team === abbr, `${abbr} has profile (archetype: ${profile.archetype})`);
    assert(profile.tradeAggression >= 0 && profile.tradeAggression <= 1, `${abbr} tradeAggression in range`);
    assert(profile.riskTolerance >= 0 && profile.riskTolerance <= 1, `${abbr} riskTolerance in range`);
  }

  // Archetype distribution — should have variety
  const archetypes = new Set(profiles.map(p => p.archetype));
  assert(archetypes.size >= 6, `${archetypes.size} distinct archetypes (expected 6+)`);

  // Value chart distribution
  const charts = new Map<string, number>();
  for (const p of profiles) {
    charts.set(p.valueChart, (charts.get(p.valueChart) ?? 0) + 1);
  }
  console.log(`  Chart distribution: ${[...charts.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  assert(charts.size >= 3, `${charts.size} distinct charts used (expected 3+)`);
}

// ── LLM Trade Tests ─────────────────────────────────────────────────────────

function buildMockContext(teamAbbr: string): TradeAIContext {
  const schedule = [];
  for (let r = 1; r <= 7; r++) {
    const teamAbbrs = Object.keys(TEAMS);
    for (let i = 0; i < 32; i++) {
      schedule.push({
        overall: (r - 1) * 32 + i + 1,
        round: r,
        currentTeam: teamAbbrs[i],
      });
    }
  }

  const teamIdx = Object.keys(TEAMS).indexOf(teamAbbr);
  const teamPicks = schedule.filter(s => s.currentTeam === teamAbbr);

  return {
    teamAbbr,
    teamPicks: teamPicks.map(s => ({ overall: s.overall, round: s.round })),
    teamFuturePicks: [
      { id: `2027-R1-${teamAbbr}`, year: 2027, round: 1 },
      { id: `2027-R2-${teamAbbr}`, year: 2027, round: 2 },
    ],
    availableRanks: Array.from({ length: 200 }, (_, i) => i + 1),
    draftedByTeam: [],
    currentPickIndex: 0,
    totalPicks: 224,
    remainingSchedule: schedule,
    strategyPrompt: 'Build through the draft. Prioritize EDGE and CB.',
  };
}

async function testEvaluateIncomingTrade(): Promise<void> {
  console.log('\n🤝 Evaluate Incoming Trade (LLM)\n');

  // Test a fair trade
  const profile = getGMProfile('BAL');
  const ctx = buildMockContext('BAL');

  console.log(`  Testing ${profile.team} (${profile.archetype}, chart=${profile.valueChart})...`);
  const result = await evaluateIncomingTrade(profile, ctx, {
    fromTeam: 'LAR',
    offeredOveralls: [32, 64],
    requestedOveralls: [14],
    offeredFuturePicks: [],
    requestedFuturePicks: [],
  });

  if (result) {
    assert(['accept', 'decline', 'counter'].includes(result.decision), `Decision: ${result.decision}`);
    assert(result.reasoning.length > 0, `Reasoning: "${result.reasoning.slice(0, 80)}..."`);
    if (result.decision === 'counter' && result.counterOffer) {
      console.log(`  Counter: offered=${JSON.stringify(result.counterOffer.offeredOveralls)}, requested=${JSON.stringify(result.counterOffer.requestedOveralls)}`);
    }
  } else {
    assert(false, 'Got null response from evaluateIncomingTrade');
  }

  // Test an obviously bad trade — fortress GM should decline
  const fortress = getGMProfile('PIT');
  const fortressCtx = buildMockContext('PIT');

  console.log(`\n  Testing ${fortress.team} (${fortress.archetype}) with a bad offer...`);
  const badResult = await evaluateIncomingTrade(fortress, fortressCtx, {
    fromTeam: 'DAL',
    offeredOveralls: [200],
    requestedOveralls: [20],
    offeredFuturePicks: [],
    requestedFuturePicks: [],
  });

  if (badResult) {
    assert(badResult.decision === 'decline', `Fortress GM ${badResult.decision === 'decline' ? 'correctly declined' : `unexpectedly ${badResult.decision}ed`} bad trade`);
    assert(badResult.reasoning.length > 0, `Reasoning: "${badResult.reasoning.slice(0, 80)}..."`);
  } else {
    assert(false, 'Got null response for bad trade evaluation');
  }
}

async function testGenerateTradeIdea(): Promise<void> {
  console.log('\n💡 Generate Trade Idea (LLM)\n');

  // Aggressive GM should generate ideas
  const profile = getGMProfile('PHI');
  const ctx = buildMockContext('PHI');

  console.log(`  Testing ${profile.team} (${profile.archetype}, aggression=${profile.tradeAggression})...`);

  // Force high aggression for test (override random check)
  const origAggression = profile.tradeAggression;
  (profile as any).tradeAggression = 1.0;

  const idea = await generateTradeIdea(profile, ctx);
  (profile as any).tradeAggression = origAggression;

  if (idea) {
    assert(!!TEAMS[idea.partnerTeam], `Partner team: ${idea.partnerTeam}`);
    assert(idea.pitch.length > 0, `Pitch: "${idea.pitch.slice(0, 80)}..."`);
    console.log(`  Offered: ${JSON.stringify(idea.offeredOveralls)}, Requested: ${JSON.stringify(idea.requestedOveralls)}`);
    console.log(`  Future offered: ${JSON.stringify(idea.offeredFuturePicks)}, Future requested: ${JSON.stringify(idea.requestedFuturePicks)}`);
  } else {
    console.log('  (No trade idea generated — this can happen)');
    passed++; // Not a failure, just the GM passing
  }
}

async function testOnClockDecision(): Promise<void> {
  console.log('\n⏰ On-Clock Trade Decision (LLM)\n');

  // Builder GM might want to trade down from a high pick
  const profile = getGMProfile('ARI');
  const ctx = buildMockContext('ARI');

  console.log(`  Testing ${profile.team} (${profile.archetype}) with pick #3...`);
  (profile as any).tradeAggression = 1.0;

  const decision = await decideOnClockTrade(profile, ctx, { overall: 3, round: 1 });
  (profile as any).tradeAggression = 0.6;

  if (decision) {
    assert(['pick', 'trade'].includes(decision.action), `Decision: ${decision.action}`);
    if (decision.action === 'trade' && decision.tradeIdea) {
      console.log(`  Trade idea: partner=${decision.tradeIdea.partnerTeam}, offered=${JSON.stringify(decision.tradeIdea.offeredOveralls)}`);
    }
  } else {
    console.log('  (Null decision — defaulting to pick)');
    passed++;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🏈 AI GM Trade System — Test Harness\n');

  // Unit tests (always run)
  testValueCharts();
  testGMProfiles();

  // LLM tests (requires Ollama)
  if (skipLLM) {
    console.log('\n⏭️  Skipping LLM tests (--no-llm)\n');
  } else if (!isOllamaConfigured()) {
    console.log('\n⚠️  Ollama not configured — skipping LLM tests\n');
  } else {
    await testEvaluateIncomingTrade();
    await testGenerateTradeIdea();
    await testOnClockDecision();
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
