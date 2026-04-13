/**
 * NFL draft pick value charts and trade evaluation.
 *
 * Four chart variants model different GM valuation philosophies:
 *   standard   — Jimmy Johnson chart (baseline)
 *   analytics  — Massey–Thaler flatter curve (devalues top picks)
 *   old_school — steeper curve (overvalues top-10)
 *   aggressive — compressed range (more trades pass the ratio gate)
 *
 * Future picks are discounted by 0.85^yearsOut on top of the round value.
 */

export type ValueChartType = 'standard' | 'analytics' | 'old_school' | 'aggressive';

// ── Jimmy Johnson baseline chart (selected anchor points, interpolated) ─────

const JIMMY_JOHNSON: Record<number, number> = {
  1: 3000, 2: 2600, 3: 2200, 4: 1800, 5: 1700, 6: 1600, 7: 1500, 8: 1400,
  9: 1350, 10: 1300, 11: 1250, 12: 1200, 13: 1150, 14: 1100, 15: 1050,
  16: 1000, 17: 950, 18: 900, 19: 875, 20: 850, 21: 800, 22: 780, 23: 760,
  24: 740, 25: 720, 26: 700, 27: 680, 28: 660, 29: 640, 30: 620, 31: 600,
  32: 590, 33: 580, 34: 560, 35: 550, 36: 540, 37: 530, 38: 520, 39: 510,
  40: 480, 45: 430, 50: 370, 55: 320, 60: 290, 64: 270, 70: 240, 75: 210,
  80: 190, 85: 170, 90: 150, 95: 135, 100: 120, 110: 100, 120: 82,
  130: 70, 140: 60, 150: 54, 160: 50, 170: 42, 180: 36, 190: 30,
  200: 24, 210: 18, 220: 12, 224: 10,
};

function interpolateStandard(overall: number): number {
  if (overall <= 0) return 3000;
  if (overall >= 224) return 10;

  const anchors = Object.keys(JIMMY_JOHNSON).map(Number).sort((a, b) => a - b);
  for (let i = 0; i < anchors.length - 1; i++) {
    if (overall >= anchors[i] && overall <= anchors[i + 1]) {
      const lo = anchors[i], hi = anchors[i + 1];
      const t = (overall - lo) / (hi - lo);
      return Math.round(JIMMY_JOHNSON[lo] * (1 - t) + JIMMY_JOHNSON[hi] * t);
    }
  }
  return 10;
}

// ── Chart scaling functions ─────────────────────────────────────────────────

function analyticsValue(overall: number): number {
  // Flatter curve: top picks worth less relative to mid-rounders
  const base = interpolateStandard(overall);
  if (overall <= 10) return Math.round(base * 0.80);
  if (overall <= 32) return Math.round(base * 0.90);
  if (overall <= 100) return Math.round(base * 1.10);
  return Math.round(base * 1.15);
}

function oldSchoolValue(overall: number): number {
  // Steeper: top picks overvalued, late rounds undervalued
  const base = interpolateStandard(overall);
  if (overall <= 10) return Math.round(base * 1.25);
  if (overall <= 32) return Math.round(base * 1.10);
  if (overall <= 100) return Math.round(base * 0.95);
  return Math.round(base * 0.85);
}

function aggressiveValue(overall: number): number {
  // Compressed: smaller gaps between picks → more trades look "close enough"
  const base = interpolateStandard(overall);
  if (overall <= 10) return Math.round(base * 0.85);
  if (overall <= 32) return Math.round(base * 0.92);
  return Math.round(base * 1.08);
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getPickValue(overall: number, chart: ValueChartType = 'standard'): number {
  switch (chart) {
    case 'analytics': return analyticsValue(overall);
    case 'old_school': return oldSchoolValue(overall);
    case 'aggressive': return aggressiveValue(overall);
    default: return interpolateStandard(overall);
  }
}

const FUTURE_DISCOUNT = 0.85;

/** Estimate value of a future-year pick by round (mid-round pick assumed). */
export function getFuturePickValue(
  year: number,
  round: number,
  chart: ValueChartType = 'standard',
): number {
  // Approximate pick number as middle of the round (round midpoint × 32)
  const midPick = (round - 1) * 32 + 16;
  const currentValue = getPickValue(midPick, chart);
  const currentYear = new Date().getFullYear();
  const yearsOut = Math.max(0, year - currentYear);
  return Math.round(currentValue * Math.pow(FUTURE_DISCOUNT, yearsOut));
}

/** Evaluate a trade from one side's perspective using their value chart. */
export function evaluateTradeValue(
  giving: { overalls: number[]; futurePickIds?: string[] },
  receiving: { overalls: number[]; futurePickIds?: string[] },
  chart: ValueChartType,
  resolveFuture: (id: string) => { year: number; round: number } | null,
): { givingValue: number; receivingValue: number; ratio: number } {
  let givingValue = 0;
  for (const o of giving.overalls) givingValue += getPickValue(o, chart);
  for (const id of giving.futurePickIds ?? []) {
    const f = resolveFuture(id);
    if (f) givingValue += getFuturePickValue(f.year, f.round, chart);
  }

  let receivingValue = 0;
  for (const o of receiving.overalls) receivingValue += getPickValue(o, chart);
  for (const id of receiving.futurePickIds ?? []) {
    const f = resolveFuture(id);
    if (f) receivingValue += getFuturePickValue(f.year, f.round, chart);
  }

  const maxVal = Math.max(givingValue, receivingValue, 1);
  const minVal = Math.max(Math.min(givingValue, receivingValue), 1);
  return { givingValue, receivingValue, ratio: maxVal / minVal };
}

/**
 * Chart-independent hard guardrail. Uses standard chart so no GM bias can
 * override it. Prevents catastrophic LLM hallucination trades.
 */
export function isTradeReasonable(
  offeredOveralls: number[],
  requestedOveralls: number[],
  offeredFuture: Array<{ year: number; round: number }> = [],
  requestedFuture: Array<{ year: number; round: number }> = [],
  maxRatio = 2.5,
): boolean {
  let offeredValue = 0;
  for (const o of offeredOveralls) offeredValue += getPickValue(o, 'standard');
  for (const f of offeredFuture) offeredValue += getFuturePickValue(f.year, f.round, 'standard');

  let requestedValue = 0;
  for (const o of requestedOveralls) requestedValue += getPickValue(o, 'standard');
  for (const f of requestedFuture) requestedValue += getFuturePickValue(f.year, f.round, 'standard');

  // If one side is empty (player-only trade), skip value check
  if (offeredValue === 0 || requestedValue === 0) return true;

  const ratio = Math.max(offeredValue, requestedValue) / Math.min(offeredValue, requestedValue);
  return ratio <= maxRatio;
}

/** Generate a human-readable value chart for embedding in LLM prompts. */
export function getValueChartPrompt(chart: ValueChartType): string {
  const picks = [1, 5, 10, 15, 20, 25, 32, 40, 50, 64, 80, 100, 130, 160, 200, 224];
  const lines = picks.map(p => `Pick ${p}: ${getPickValue(p, chart)}`);
  const label = chart === 'standard' ? 'Standard (Jimmy Johnson)'
    : chart === 'analytics' ? 'Analytics (Massey-Thaler, flatter curve)'
    : chart === 'old_school' ? 'Old School (top-heavy)'
    : 'Aggressive (compressed)';
  return `## Draft Pick Value Chart — ${label}\n${lines.join(' | ')}\nFuture picks: ~85% per year out (2027 R1 ≈ ${getFuturePickValue(2027, 1, chart)}, 2028 R1 ≈ ${getFuturePickValue(2028, 1, chart)}).`;
}
