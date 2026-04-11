/**
 * Merge individual Beast position JSON files into a single unified file.
 * Creates two outputs:
 *   - beast-scouting.json: Full data (all fields)
 *   - beast-scouting-compact.json: Trimmed for AI context (no background, minimal stats)
 *
 * Usage: npx ts-node scripts/merge-beast.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const BEAST_DIR = path.join(__dirname, '..', 'data', 'beastdata');
const OUT_FULL = path.join(__dirname, '..', 'data', 'beast-scouting.json');
const OUT_COMPACT = path.join(__dirname, '..', 'data', 'beast-scouting-compact.json');

interface MeasurementSet {
  height_code?: string;
  height?: string;
  weight?: number;
  hand_size?: string;
  arm_length?: string;
  wingspan?: string;
  bench_press?: number | null;
  forty_yard?: number | null;
  twenty_yard?: number | null;
  ten_yard?: number | null;
  vertical_jump?: number | null;
  broad_jump?: string | null;
  short_shuttle?: number | null;
  three_cone?: number | null;
  notes?: string;
}

interface RawProspect {
  position: string;
  position_rank: number;
  name_school_raw?: string;
  name: string;
  school: string;
  grade?: string;
  overall_rank?: number | null;
  year?: string;
  birthday?: string;
  age?: number;
  height?: string;
  height_code?: string;
  weight?: string | number;
  jersey?: string;
  type?: string;
  background?: string;
  college_stats?: Array<Record<string, unknown>>;
  measurements?: { combine?: MeasurementSet; pro_day?: MeasurementSet };
  strengths?: string[];
  weaknesses?: string[];
  summary?: string;
  // Best-of-rest: measurables are top-level
  forty_yard?: number | null;
  twenty_yard?: number | null;
  ten_yard?: number | null;
  vertical_jump?: string | number | null;
  broad_jump?: string | null;
  short_shuttle?: number | null;
  three_cone?: number | null;
  hand_size?: string | null;
  arm_length?: string | null;
  wingspan?: string | null;
  bench_press?: number | null;
}

interface CompactMeasurements {
  ht?: string;
  wt?: number;
  hand?: string;
  arm?: string;
  wing?: string;
  bench?: number | null;
  forty?: number | null;
  vert?: number | null;
  broad?: string | null;
  shuttle?: number | null;
  cone?: number | null;
}

interface CompactProspect {
  pos: string;
  posRank: number;
  name: string;
  school: string;
  grade: string;
  ovrRank: number | null;
  year?: string;
  age?: number;
  ht?: string;
  wt?: string;
  strengths?: string[];
  weaknesses?: string[];
  summary?: string;
  combine?: CompactMeasurements;
  proDayDelta?: CompactMeasurements;
  stats?: Array<Record<string, unknown>>;
}

function compactMeasurements(m: MeasurementSet): CompactMeasurements | undefined {
  const c: CompactMeasurements = {};
  if (m.height) c.ht = m.height;
  if (m.weight) c.wt = m.weight;
  if (m.hand_size) c.hand = m.hand_size;
  if (m.arm_length) c.arm = m.arm_length;
  if (m.wingspan) c.wing = m.wingspan;
  if (m.bench_press != null) c.bench = m.bench_press;
  if (m.forty_yard != null) c.forty = m.forty_yard;
  if (m.vertical_jump != null) c.vert = m.vertical_jump;
  if (m.broad_jump != null) c.broad = m.broad_jump;
  if (m.short_shuttle != null) c.shuttle = m.short_shuttle;
  if (m.three_cone != null) c.cone = m.three_cone;
  return Object.keys(c).length > 0 ? c : undefined;
}

function run() {
  const files = fs.readdirSync(BEAST_DIR).filter(f => f.startsWith('beast_') && f.endsWith('.json') && f !== 'beast_top100.json');

  const allProspects: RawProspect[] = [];
  const compactProspects: CompactProspect[] = [];

  for (const file of files.sort()) {
    const data = JSON.parse(fs.readFileSync(path.join(BEAST_DIR, file), 'utf-8'));
    const prospects: RawProspect[] = data.prospects || [];

    for (const p of prospects) {
      allProspects.push(p);

      const wt = typeof p.weight === 'string' ? p.weight.replace(' lbs.', '') : p.weight ? String(p.weight) : undefined;

      const compact: CompactProspect = {
        pos: p.position,
        posRank: p.position_rank,
        name: p.name,
        school: p.school,
        grade: p.grade ?? '',
        ovrRank: p.overall_rank ?? null,
      };
      if (p.year) compact.year = p.year;
      if (p.age) compact.age = p.age;
      if (p.height) compact.ht = p.height;
      if (wt) compact.wt = wt;
      if (p.strengths?.length) compact.strengths = p.strengths;
      if (p.weaknesses?.length) compact.weaknesses = p.weaknesses;
      if (p.summary) compact.summary = p.summary;

      if (p.measurements?.combine) {
        // Full writeup: structured nested measurements
        compact.combine = compactMeasurements(p.measurements.combine);
      }
      if (p.measurements?.pro_day) {
        compact.proDayDelta = compactMeasurements(p.measurements.pro_day);
      }

      if (!p.measurements && p.type === 'best_of_rest') {
        // Best-of-rest: measurables are top-level fields
        const topLevel: MeasurementSet = {};
        if (p.height) topLevel.height = p.height;
        if (p.weight) topLevel.weight = typeof p.weight === 'number' ? p.weight : undefined;
        if (p.hand_size) topLevel.hand_size = p.hand_size;
        if (p.arm_length) topLevel.arm_length = p.arm_length;
        if (p.wingspan) topLevel.wingspan = p.wingspan;
        if (p.bench_press != null) topLevel.bench_press = p.bench_press;
        if (p.forty_yard != null) topLevel.forty_yard = p.forty_yard;
        if (p.vertical_jump != null) topLevel.vertical_jump = typeof p.vertical_jump === 'string' ? null : p.vertical_jump;
        if (p.broad_jump != null) topLevel.broad_jump = p.broad_jump;
        if (p.short_shuttle != null) topLevel.short_shuttle = p.short_shuttle;
        if (p.three_cone != null) topLevel.three_cone = p.three_cone;
        // Store vertical_jump string separately since CompactMeasurements.vert is number
        const cm = compactMeasurements(topLevel);
        if (cm) {
          // Override vert with the raw string value if it's a string like "35 1/2"
          if (typeof p.vertical_jump === 'string') (cm as Record<string, unknown>).vert = p.vertical_jump;
          compact.combine = cm;
        }
      }

      // Full position-specific stats
      if (p.college_stats?.length) {
        compact.stats = p.college_stats
          .filter(s => (s as Record<string, unknown>).year !== 'Total')
          .map(s => {
            const row = { ...s } as Record<string, unknown>;
            delete row.notes;
            return row;
          });
      }

      compactProspects.push(compact);
    }
  }

  // Sort: by overall rank first (if present), then by position rank
  compactProspects.sort((a, b) => {
    if (a.ovrRank && b.ovrRank) return a.ovrRank - b.ovrRank;
    if (a.ovrRank) return -1;
    if (b.ovrRank) return 1;
    return a.posRank - b.posRank;
  });

  // Write full version
  const fullJson = JSON.stringify(allProspects, null, 2);
  fs.writeFileSync(OUT_FULL, fullJson);
  console.log(`Full: ${allProspects.length} prospects, ${(fullJson.length / 1024).toFixed(0)} KB → ${OUT_FULL}`);

  // Write compact version
  const compactJson = JSON.stringify(compactProspects);
  fs.writeFileSync(OUT_COMPACT, compactJson);
  console.log(`Compact: ${compactProspects.length} prospects, ${(compactJson.length / 1024).toFixed(0)} KB → ${OUT_COMPACT}`);
  console.log(`Compact approx tokens: ~${Math.round(compactJson.length / 4)}  (~${(compactJson.length / 4000).toFixed(0)}k)`);

  const withWriteup = compactProspects.filter(p => p.strengths?.length || p.summary);
  const basicOnly = compactProspects.filter(p => !p.strengths?.length && !p.summary);
  console.log(`  With full writeup: ${withWriteup.length}, Basic (measurables only): ${basicOnly.length}`);

  // Position breakdown
  const posCounts: Record<string, number> = {};
  for (const p of compactProspects) {
    posCounts[p.pos] = (posCounts[p.pos] || 0) + 1;
  }
  console.log('\nPosition counts:');
  for (const [pos, count] of Object.entries(posCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pos}: ${count}`);
  }
}

run();
