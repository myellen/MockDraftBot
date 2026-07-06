/**
 * Build gmBoards.ts from agent output files.
 * Reads each agent's output, extracts the board, maps names to ranks.
 *
 * Usage: npx ts-node scripts/build-gm-boards.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractBoard, processBoard } from './process-agent-boards';

const BASE_DIR = path.join(
  process.env.LOCALAPPDATA || '',
  'Temp/claude/C--Users-Max-mcp-discord-MockDraftBot/4d0a8264-8a73-402a-86d5-e4dc1e207ace/tasks',
);

const AGENT_MAP: Record<string, string> = {
  'a277b62bd91f32ada': 'MIA',
  'aa6c7006bb985ed83': 'NE',
  'a63f4889a09a4adb7': 'NYJ',
  'a05fd36439b5d9e3a': 'BAL',
  'aad74d7ec8a7081e0': 'CIN',
  'adf83a3ef2ab5a6a3': 'CLE',
  'a61ed5e85c3fdce55': 'PIT',
  'ae663c0657e8721f9': 'HOU',
  'af4b7bb952e6f9fd1': 'IND',
  'a938b974e4fa4d93b': 'JAX',
  'acf89ea1149adcc79': 'TEN',
  'af3ea5fd01bb5c27d': 'DEN',
  'a4a7c9d06805934a4': 'KC',
  'a06bc38430a964be4': 'LV',
  'a58d5b19807763764': 'LAC',
  'af98405e75d106d2d': 'DAL',
  'a026fcdb1c839ec5e': 'NYG',
  'aa18d278c3b753c6c': 'PHI',
  'a4e3cee68376c32b6': 'WAS',
  'a0a0a3a25500bad4d': 'CHI',
  'ab2404c5573c0fa30': 'DET',
  'aae2d0e53d0244c4b': 'GB',
  'ade4456d19461d84b': 'MIN',
  'ace45374063daaea9': 'ATL',
  'abc055555cd9595a1': 'CAR',
  'ae4a3e1f1259e3b4e': 'NO',
  'a9f6d35fa27236b99': 'TB',
  'af504cccd280178f0': 'ARI',
  'a0d4122344ae0e812': 'LAR',
  'a5a4399d749781136': 'SF',
  'abd4d01eeec395a56': 'SEA',
};

// BUF board from prior Ollama run (already in gmBoards.ts)
const BUF_BOARD = [
  2, 4, 1, 5, 6, 8, 7, 9, 11, 3, 13, 10, 12, 20, 23, 16, 17, 21, 25, 24,
  26, 27, 28, 22, 36, 15, 33, 32, 30, 31, 41, 42, 44, 40, 43, 45, 46, 47, 48, 49,
  50, 51, 52, 53, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 70, 71,
  72, 73, 74, 75, 76, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92,
  93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112,
  113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132,
  133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152,
  153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 165, 166, 167, 168, 169, 170, 171, 172, 173,
  174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193,
  194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213,
  214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233,
  234, 235, 236, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250,
];

function extractBoardFromAgentOutput(filePath: string): string[] | null {
  const raw = fs.readFileSync(filePath, 'utf-8');

  // Agent output is JSONL — extract text content that contains ===BOARD===
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.includes('===BOARD===')) continue;
    try {
      const obj = JSON.parse(line);
      // The board could be in message.content (text) or in a tool_result
      const content = obj?.message?.content;
      if (typeof content === 'string') {
        const board = extractBoard(content);
        if (board && board.length > 10) return board;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            const board = extractBoard(block.text);
            if (board && board.length > 10) return board;
          }
        }
      }
    } catch { /* skip non-JSON lines */ }
  }

  // Fallback: scan all lines for any board
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const content = obj?.message?.content;
      if (typeof content === 'string' && content.includes('===BOARD===')) {
        const board = extractBoard(content);
        if (board && board.length > 10) return board;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.includes('===BOARD===')) {
            const board = extractBoard(block.text);
            if (board && board.length > 10) return board;
          }
        }
      }
    } catch { /* skip */ }
  }

  return null;
}

// Process all agents
const boards: Record<string, number[]> = { BUF: BUF_BOARD };
const errors: string[] = [];

for (const [agentId, team] of Object.entries(AGENT_MAP)) {
  const filePath = path.join(BASE_DIR, `${agentId}.output`);
  if (!fs.existsSync(filePath)) {
    errors.push(`${team}: output file not found`);
    continue;
  }

  const names = extractBoardFromAgentOutput(filePath);
  if (!names) {
    errors.push(`${team}: could not extract board`);
    continue;
  }

  const { ranks, unmatched } = processBoard(names);
  boards[team] = ranks;

  console.log(`${team}: ${ranks.length} matched, ${unmatched.length} unmatched of ${names.length} total`);
  if (unmatched.length > 0) {
    console.log(`  Unmatched: ${unmatched.slice(0, 10).join(', ')}${unmatched.length > 10 ? '...' : ''}`);
  }
}

if (errors.length > 0) {
  console.error('\nErrors:');
  for (const e of errors) console.error(`  ${e}`);
}

// Sort teams in NFL division order
const TEAM_ORDER = [
  'BUF', 'MIA', 'NE', 'NYJ',
  'BAL', 'CIN', 'CLE', 'PIT',
  'HOU', 'IND', 'JAX', 'TEN',
  'DEN', 'KC', 'LV', 'LAC',
  'DAL', 'NYG', 'PHI', 'WAS',
  'CHI', 'DET', 'GB', 'MIN',
  'ATL', 'CAR', 'NO', 'TB',
  'ARI', 'LAR', 'SF', 'SEA',
];

// Generate output
const teamEntries = TEAM_ORDER
  .filter(t => boards[t])
  .map(team => {
    const ranks = boards[team];
    // Format: 20 numbers per line
    const lines: string[] = [];
    for (let i = 0; i < ranks.length; i += 20) {
      lines.push('    ' + ranks.slice(i, i + 20).join(', ') + ',');
    }
    return `  '${team}': [\n${lines.join('\n')}\n  ]`;
  });

const output = `/**
 * Pre-generated draft boards for AI GMs.
 * Built by Claude Code subagents using wiki-based GM profiles and Beast scouting data.
 *
 * Each array is an ordered list of prospect ranks (from prospects.ts).
 * Index 0 = GM's #1 overall prospect.
 *
 * Generated: ${new Date().toISOString().split('T')[0]}
 */

export const GM_BOARDS: Record<string, number[]> = {
${teamEntries.join(',\n')},
};
`;

const outPath = path.join(__dirname, '..', 'src', 'data', 'gmBoards.college.ts');
fs.writeFileSync(outPath, output);
console.log(`\nWrote ${Object.keys(boards).length} boards to ${outPath}`);
