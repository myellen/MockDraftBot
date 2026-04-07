import { PlayerSalary } from '../draft/types';

// 2026 NFL salary cap (estimated) in thousands of dollars
export const SALARY_CAP = 301200;

// Rookie minimum salary in thousands (used for Rule of 51 / pick cap impact)
export const ROOKIE_MINIMUM = 885;

// Rookie cap hits by overall pick number (year-1 cap charge in thousands)
// Based on projected 2026 rookie wage scale
const ROOKIE_CAP_HITS: number[] = [
  // Round 1 (picks 1-32)
  12400, 11200, 10400, 9800, 9200, 8700, 8200, 7800,
  7400, 7100, 6800, 6500, 6200, 6000, 5800, 5600,
  5400, 5200, 5000, 4850, 4700, 4550, 4400, 4250,
  4100, 3950, 3850, 3750, 3650, 3550, 3450, 3350,
  // Round 2 (picks 33-64)
  3250, 3150, 3050, 2950, 2850, 2800, 2750, 2700,
  2650, 2600, 2550, 2500, 2450, 2400, 2350, 2300,
  2250, 2200, 2150, 2100, 2050, 2000, 1975, 1950,
  1925, 1900, 1875, 1850, 1825, 1800, 1775, 1750,
  // Round 3 (picks 65-100)
  1725, 1700, 1680, 1660, 1640, 1620, 1600, 1580,
  1560, 1540, 1520, 1500, 1480, 1460, 1440, 1420,
  1400, 1385, 1370, 1355, 1340, 1325, 1310, 1295,
  1280, 1265, 1250, 1235, 1220, 1205, 1190, 1175,
  1160, 1145, 1130, 1115,
  // Rounds 4-7: league minimum
];

export function getRookieCapHit(overall: number): number {
  if (overall <= 0) return 1000;
  if (overall <= ROOKIE_CAP_HITS.length) return ROOKIE_CAP_HITS[overall - 1];
  return 1000;
}

// Generated via: npx ts-node scripts/generate-salaries.ts
// Source: Spotrac / OverTheCap + trade machine overrides
// Example shows structure only — run the generator for full data
export const SALARIES: Record<string, Record<string, PlayerSalary>> = {
  BUF: {
    "josh allen": { capHit: 46440, deadMoney: 97907, baseSalary: 16440 },
    "ed oliver": { capHit: 17400, deadMoney: 9967, baseSalary: 9400 },
    "khalil shakir": { capHit: 4824, deadMoney: 3627, baseSalary: 1197 },
  },
  DAL: {
    "dak prescott": { capHit: 89190, deadMoney: 128190, baseSalary: 1800 },
    "george pickens": { capHit: 27298, deadMoney: 0, baseSalary: 27298 },
    "ceedee lamb": { capHit: 26800, deadMoney: 22800, baseSalary: 14800 },
  },
};
