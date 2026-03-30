// 2026 NFL Draft — Complete pick order
// Source: ESPN, NFL.com, Tankathon, NFL Football Operations (comp picks)
// Verified: March 2026. Total: 257 picks (224 standard + 33 compensatory)
// Updated: ATL/PHI Sydney Brown pick swap; LV R5 chain (→HOU); 2027/2028 future picks corrected
// currentTeam = team currently holding the pick after all known trades

export interface DraftPickEntry {
  overall: number;
  round: number;
  roundPick: number;
  originalTeam: string;  // team assigned to this slot by draft position / comp award
  currentTeam: string;   // team that actually holds the pick
}

export const DRAFT_ORDER: DraftPickEntry[] = [
  // ── Round 1 ─────────────────────────────────────────────────────────────
  { overall:   1, round: 1, roundPick:  1, originalTeam: 'LV',  currentTeam: 'LV'  },
  { overall:   2, round: 1, roundPick:  2, originalTeam: 'NYJ', currentTeam: 'NYJ' },
  { overall:   3, round: 1, roundPick:  3, originalTeam: 'ARI', currentTeam: 'ARI' },
  { overall:   4, round: 1, roundPick:  4, originalTeam: 'TEN', currentTeam: 'TEN' },
  { overall:   5, round: 1, roundPick:  5, originalTeam: 'NYG', currentTeam: 'NYG' },
  { overall:   6, round: 1, roundPick:  6, originalTeam: 'CLE', currentTeam: 'CLE' },
  { overall:   7, round: 1, roundPick:  7, originalTeam: 'WAS', currentTeam: 'WAS' },
  { overall:   8, round: 1, roundPick:  8, originalTeam: 'NO',  currentTeam: 'NO'  },
  { overall:   9, round: 1, roundPick:  9, originalTeam: 'KC',  currentTeam: 'KC'  },
  { overall:  10, round: 1, roundPick: 10, originalTeam: 'CIN', currentTeam: 'CIN' },
  { overall:  11, round: 1, roundPick: 11, originalTeam: 'MIA', currentTeam: 'MIA' },
  { overall:  12, round: 1, roundPick: 12, originalTeam: 'DAL', currentTeam: 'DAL' },
  { overall:  13, round: 1, roundPick: 13, originalTeam: 'ATL', currentTeam: 'LAR' }, // ATL→LAR
  { overall:  14, round: 1, roundPick: 14, originalTeam: 'BAL', currentTeam: 'BAL' },
  { overall:  15, round: 1, roundPick: 15, originalTeam: 'TB',  currentTeam: 'TB'  },
  { overall:  16, round: 1, roundPick: 16, originalTeam: 'IND', currentTeam: 'NYJ' }, // IND→NYJ (Sauce Gardner)
  { overall:  17, round: 1, roundPick: 17, originalTeam: 'DET', currentTeam: 'DET' },
  { overall:  18, round: 1, roundPick: 18, originalTeam: 'MIN', currentTeam: 'MIN' },
  { overall:  19, round: 1, roundPick: 19, originalTeam: 'CAR', currentTeam: 'CAR' },
  { overall:  20, round: 1, roundPick: 20, originalTeam: 'GB',  currentTeam: 'DAL' }, // GB→DAL (Micah Parsons)
  { overall:  21, round: 1, roundPick: 21, originalTeam: 'PIT', currentTeam: 'PIT' },
  { overall:  22, round: 1, roundPick: 22, originalTeam: 'LAC', currentTeam: 'LAC' },
  { overall:  23, round: 1, roundPick: 23, originalTeam: 'PHI', currentTeam: 'PHI' },
  { overall:  24, round: 1, roundPick: 24, originalTeam: 'JAX', currentTeam: 'CLE' }, // JAX→CLE
  { overall:  25, round: 1, roundPick: 25, originalTeam: 'CHI', currentTeam: 'CHI' },
  { overall:  26, round: 1, roundPick: 26, originalTeam: 'BUF', currentTeam: 'BUF' },
  { overall:  27, round: 1, roundPick: 27, originalTeam: 'SF',  currentTeam: 'SF'  },
  { overall:  28, round: 1, roundPick: 28, originalTeam: 'HOU', currentTeam: 'HOU' },
  { overall:  29, round: 1, roundPick: 29, originalTeam: 'LAR', currentTeam: 'KC'  }, // LAR→KC (Trent McDuffie)
  { overall:  30, round: 1, roundPick: 30, originalTeam: 'DEN', currentTeam: 'MIA' }, // DEN→MIA (Jaylen Waddle)
  { overall:  31, round: 1, roundPick: 31, originalTeam: 'NE',  currentTeam: 'NE'  },
  { overall:  32, round: 1, roundPick: 32, originalTeam: 'SEA', currentTeam: 'SEA' },

  // ── Round 2 ─────────────────────────────────────────────────────────────
  { overall:  33, round: 2, roundPick:  1, originalTeam: 'NYJ', currentTeam: 'NYJ' },
  { overall:  34, round: 2, roundPick:  2, originalTeam: 'ARI', currentTeam: 'ARI' },
  { overall:  35, round: 2, roundPick:  3, originalTeam: 'TEN', currentTeam: 'TEN' },
  { overall:  36, round: 2, roundPick:  4, originalTeam: 'LV',  currentTeam: 'LV'  },
  { overall:  37, round: 2, roundPick:  5, originalTeam: 'NYG', currentTeam: 'NYG' },
  { overall:  38, round: 2, roundPick:  6, originalTeam: 'WAS', currentTeam: 'HOU' }, // WAS→HOU (Laremy Tunsil)
  { overall:  39, round: 2, roundPick:  7, originalTeam: 'CLE', currentTeam: 'CLE' },
  { overall:  40, round: 2, roundPick:  8, originalTeam: 'KC',  currentTeam: 'KC'  },
  { overall:  41, round: 2, roundPick:  9, originalTeam: 'CIN', currentTeam: 'CIN' },
  { overall:  42, round: 2, roundPick: 10, originalTeam: 'NO',  currentTeam: 'NO'  },
  { overall:  43, round: 2, roundPick: 11, originalTeam: 'MIA', currentTeam: 'MIA' },
  { overall:  44, round: 2, roundPick: 12, originalTeam: 'DAL', currentTeam: 'NYJ' }, // DAL→NYJ (Quinnen Williams)
  { overall:  45, round: 2, roundPick: 13, originalTeam: 'BAL', currentTeam: 'BAL' },
  { overall:  46, round: 2, roundPick: 14, originalTeam: 'TB',  currentTeam: 'TB'  },
  { overall:  47, round: 2, roundPick: 15, originalTeam: 'IND', currentTeam: 'IND' },
  { overall:  48, round: 2, roundPick: 16, originalTeam: 'ATL', currentTeam: 'ATL' },
  { overall:  49, round: 2, roundPick: 17, originalTeam: 'MIN', currentTeam: 'MIN' },
  { overall:  50, round: 2, roundPick: 18, originalTeam: 'DET', currentTeam: 'DET' },
  { overall:  51, round: 2, roundPick: 19, originalTeam: 'CAR', currentTeam: 'CAR' },
  { overall:  52, round: 2, roundPick: 20, originalTeam: 'GB',  currentTeam: 'GB'  },
  { overall:  53, round: 2, roundPick: 21, originalTeam: 'PIT', currentTeam: 'PIT' },
  { overall:  54, round: 2, roundPick: 22, originalTeam: 'PHI', currentTeam: 'PHI' },
  { overall:  55, round: 2, roundPick: 23, originalTeam: 'LAC', currentTeam: 'LAC' },
  { overall:  56, round: 2, roundPick: 24, originalTeam: 'JAX', currentTeam: 'JAX' },
  { overall:  57, round: 2, roundPick: 25, originalTeam: 'CHI', currentTeam: 'CHI' },
  { overall:  58, round: 2, roundPick: 26, originalTeam: 'SF',  currentTeam: 'SF'  },
  { overall:  59, round: 2, roundPick: 27, originalTeam: 'HOU', currentTeam: 'HOU' },
  { overall:  60, round: 2, roundPick: 28, originalTeam: 'BUF', currentTeam: 'CHI' }, // BUF→CHI
  { overall:  61, round: 2, roundPick: 29, originalTeam: 'LAR', currentTeam: 'LAR' },
  { overall:  62, round: 2, roundPick: 30, originalTeam: 'DEN', currentTeam: 'DEN' },
  { overall:  63, round: 2, roundPick: 31, originalTeam: 'NE',  currentTeam: 'NE'  },
  { overall:  64, round: 2, roundPick: 32, originalTeam: 'SEA', currentTeam: 'SEA' },

  // ── Round 3 (36 picks — 32 standard + 4 comp) ───────────────────────────
  { overall:  65, round: 3, roundPick:  1, originalTeam: 'ARI', currentTeam: 'ARI' },
  { overall:  66, round: 3, roundPick:  2, originalTeam: 'TEN', currentTeam: 'TEN' },
  { overall:  67, round: 3, roundPick:  3, originalTeam: 'LV',  currentTeam: 'LV'  },
  { overall:  68, round: 3, roundPick:  4, originalTeam: 'NYJ', currentTeam: 'PHI' }, // NYJ→PHI (Hassan Reddick)
  { overall:  69, round: 3, roundPick:  5, originalTeam: 'NYG', currentTeam: 'HOU' }, // NYG→HOU
  { overall:  70, round: 3, roundPick:  6, originalTeam: 'CLE', currentTeam: 'CLE' },
  { overall:  71, round: 3, roundPick:  7, originalTeam: 'WAS', currentTeam: 'WAS' },
  { overall:  72, round: 3, roundPick:  8, originalTeam: 'CIN', currentTeam: 'CIN' },
  { overall:  73, round: 3, roundPick:  9, originalTeam: 'NO',  currentTeam: 'NO'  },
  { overall:  74, round: 3, roundPick: 10, originalTeam: 'KC',  currentTeam: 'KC'  },
  { overall:  75, round: 3, roundPick: 11, originalTeam: 'MIA', currentTeam: 'MIA' },
  { overall:  76, round: 3, roundPick: 12, originalTeam: 'DAL', currentTeam: 'PIT' }, // DAL→PIT (George Pickens)
  { overall:  77, round: 3, roundPick: 13, originalTeam: 'TB',  currentTeam: 'TB'  },
  { overall:  78, round: 3, roundPick: 14, originalTeam: 'IND', currentTeam: 'IND' },
  { overall:  79, round: 3, roundPick: 15, originalTeam: 'ATL', currentTeam: 'ATL' },
  { overall:  80, round: 3, roundPick: 16, originalTeam: 'BAL', currentTeam: 'BAL' },
  { overall:  81, round: 3, roundPick: 17, originalTeam: 'DET', currentTeam: 'JAX' }, // DET→JAX (Aaron Glenn minority-hire comp)
  { overall:  82, round: 3, roundPick: 18, originalTeam: 'MIN', currentTeam: 'MIN' },
  { overall:  83, round: 3, roundPick: 19, originalTeam: 'CAR', currentTeam: 'CAR' },
  { overall:  84, round: 3, roundPick: 20, originalTeam: 'GB',  currentTeam: 'GB'  },
  { overall:  85, round: 3, roundPick: 21, originalTeam: 'PIT', currentTeam: 'PIT' },
  { overall:  86, round: 3, roundPick: 22, originalTeam: 'LAC', currentTeam: 'LAC' },
  { overall:  87, round: 3, roundPick: 23, originalTeam: 'PHI', currentTeam: 'MIA' }, // PHI→MIA (Jaelan Phillips)
  { overall:  88, round: 3, roundPick: 24, originalTeam: 'JAX', currentTeam: 'JAX' },
  { overall:  89, round: 3, roundPick: 25, originalTeam: 'CHI', currentTeam: 'CHI' },
  { overall:  90, round: 3, roundPick: 26, originalTeam: 'HOU', currentTeam: 'MIA' }, // HOU→MIA
  { overall:  91, round: 3, roundPick: 27, originalTeam: 'BUF', currentTeam: 'BUF' },
  { overall:  92, round: 3, roundPick: 28, originalTeam: 'SF',  currentTeam: 'DAL' }, // SF→DAL
  { overall:  93, round: 3, roundPick: 29, originalTeam: 'LAR', currentTeam: 'LAR' },
  { overall:  94, round: 3, roundPick: 30, originalTeam: 'DEN', currentTeam: 'MIA' }, // DEN→MIA (Jaylen Waddle)
  { overall:  95, round: 3, roundPick: 31, originalTeam: 'NE',  currentTeam: 'NE'  },
  { overall:  96, round: 3, roundPick: 32, originalTeam: 'SEA', currentTeam: 'SEA' },
  // Comp picks
  { overall:  97, round: 3, roundPick: 33, originalTeam: 'MIN', currentTeam: 'MIN' }, // COMP
  { overall:  98, round: 3, roundPick: 34, originalTeam: 'PHI', currentTeam: 'PHI' }, // COMP
  { overall:  99, round: 3, roundPick: 35, originalTeam: 'PIT', currentTeam: 'PIT' }, // COMP
  { overall: 100, round: 3, roundPick: 36, originalTeam: 'DET', currentTeam: 'JAX' }, // DET minority-hire COMP→JAX

  // ── Round 4 (40 picks — 32 standard + 8 comp) ───────────────────────────
  { overall: 101, round: 4, roundPick:  1, originalTeam: 'TEN', currentTeam: 'TEN' },
  { overall: 102, round: 4, roundPick:  2, originalTeam: 'LV',  currentTeam: 'LV'  },
  { overall: 103, round: 4, roundPick:  3, originalTeam: 'NYJ', currentTeam: 'NYJ' },
  { overall: 104, round: 4, roundPick:  4, originalTeam: 'ARI', currentTeam: 'ARI' },
  { overall: 105, round: 4, roundPick:  5, originalTeam: 'NYG', currentTeam: 'NYG' },
  { overall: 106, round: 4, roundPick:  6, originalTeam: 'WAS', currentTeam: 'HOU' }, // WAS→HOU (Laremy Tunsil)
  { overall: 107, round: 4, roundPick:  7, originalTeam: 'CLE', currentTeam: 'CLE' },
  { overall: 108, round: 4, roundPick:  8, originalTeam: 'NO',  currentTeam: 'DEN' }, // NO→DEN (Devaughn Vele)
  { overall: 109, round: 4, roundPick:  9, originalTeam: 'KC',  currentTeam: 'KC'  },
  { overall: 110, round: 4, roundPick: 10, originalTeam: 'CIN', currentTeam: 'CIN' },
  { overall: 111, round: 4, roundPick: 11, originalTeam: 'MIA', currentTeam: 'DEN' }, // MIA→DEN (Jaylen Waddle)
  { overall: 112, round: 4, roundPick: 12, originalTeam: 'DAL', currentTeam: 'DAL' },
  { overall: 113, round: 4, roundPick: 13, originalTeam: 'IND', currentTeam: 'IND' },
  { overall: 114, round: 4, roundPick: 14, originalTeam: 'ATL', currentTeam: 'PHI' }, // ATL→PHI (Sydney Brown)
  { overall: 115, round: 4, roundPick: 15, originalTeam: 'BAL', currentTeam: 'BAL' },
  { overall: 116, round: 4, roundPick: 16, originalTeam: 'TB',  currentTeam: 'TB'  },
  { overall: 117, round: 4, roundPick: 17, originalTeam: 'MIN', currentTeam: 'LV'  }, // MIN→LV (via JAX)
  { overall: 118, round: 4, roundPick: 18, originalTeam: 'DET', currentTeam: 'DET' },
  { overall: 119, round: 4, roundPick: 19, originalTeam: 'CAR', currentTeam: 'CAR' },
  { overall: 120, round: 4, roundPick: 20, originalTeam: 'GB',  currentTeam: 'GB'  },
  { overall: 121, round: 4, roundPick: 21, originalTeam: 'PIT', currentTeam: 'PIT' },
  { overall: 122, round: 4, roundPick: 22, originalTeam: 'PHI', currentTeam: 'ATL' }, // PHI→ATL (Sydney Brown)
  { overall: 123, round: 4, roundPick: 23, originalTeam: 'LAC', currentTeam: 'LAC' },
  { overall: 124, round: 4, roundPick: 24, originalTeam: 'JAX', currentTeam: 'JAX' },
  { overall: 125, round: 4, roundPick: 25, originalTeam: 'CHI', currentTeam: 'NE'  }, // CHI→NE
  { overall: 126, round: 4, roundPick: 26, originalTeam: 'BUF', currentTeam: 'BUF' },
  { overall: 127, round: 4, roundPick: 27, originalTeam: 'SF',  currentTeam: 'SF'  },
  { overall: 128, round: 4, roundPick: 28, originalTeam: 'HOU', currentTeam: 'DET' }, // HOU→DET
  { overall: 129, round: 4, roundPick: 29, originalTeam: 'LAR', currentTeam: 'CHI' }, // LAR→CHI
  { overall: 130, round: 4, roundPick: 30, originalTeam: 'DEN', currentTeam: 'MIA' }, // DEN→MIA (Jaylen Waddle)
  { overall: 131, round: 4, roundPick: 31, originalTeam: 'NE',  currentTeam: 'NE'  },
  { overall: 132, round: 4, roundPick: 32, originalTeam: 'SEA', currentTeam: 'NO'  }, // SEA→NO
  // Comp picks
  { overall: 133, round: 4, roundPick: 33, originalTeam: 'SF',  currentTeam: 'SF'  }, // COMP
  { overall: 134, round: 4, roundPick: 34, originalTeam: 'LV',  currentTeam: 'LV'  }, // COMP
  { overall: 135, round: 4, roundPick: 35, originalTeam: 'PIT', currentTeam: 'PIT' }, // COMP
  { overall: 136, round: 4, roundPick: 36, originalTeam: 'NO',  currentTeam: 'NO'  }, // COMP
  { overall: 137, round: 4, roundPick: 37, originalTeam: 'PHI', currentTeam: 'PHI' }, // COMP
  { overall: 138, round: 4, roundPick: 38, originalTeam: 'SF',  currentTeam: 'SF'  }, // COMP
  { overall: 139, round: 4, roundPick: 39, originalTeam: 'SF',  currentTeam: 'SF'  }, // COMP
  { overall: 140, round: 4, roundPick: 40, originalTeam: 'NYJ', currentTeam: 'NYJ' }, // COMP

  // ── Round 5 (41 picks — 32 standard + 9 comp) ───────────────────────────
  { overall: 141, round: 5, roundPick:  1, originalTeam: 'LV',  currentTeam: 'HOU' }, // LV→CLE (Pickett)→HOU (Tytus Howard)
  { overall: 142, round: 5, roundPick:  2, originalTeam: 'NYJ', currentTeam: 'TEN' }, // NYJ→TEN
  { overall: 143, round: 5, roundPick:  3, originalTeam: 'ARI', currentTeam: 'ARI' },
  { overall: 144, round: 5, roundPick:  4, originalTeam: 'TEN', currentTeam: 'TEN' },
  { overall: 145, round: 5, roundPick:  5, originalTeam: 'NYG', currentTeam: 'NYG' },
  { overall: 146, round: 5, roundPick:  6, originalTeam: 'CLE', currentTeam: 'CLE' },
  { overall: 147, round: 5, roundPick:  7, originalTeam: 'WAS', currentTeam: 'WAS' },
  { overall: 148, round: 5, roundPick:  8, originalTeam: 'KC',  currentTeam: 'KC'  },
  { overall: 149, round: 5, roundPick:  9, originalTeam: 'CIN', currentTeam: 'CLE' }, // CIN→CLE
  { overall: 150, round: 5, roundPick: 10, originalTeam: 'NO',  currentTeam: 'NO'  },
  { overall: 151, round: 5, roundPick: 11, originalTeam: 'MIA', currentTeam: 'MIA' },
  { overall: 152, round: 5, roundPick: 12, originalTeam: 'DAL', currentTeam: 'DAL' },
  { overall: 153, round: 5, roundPick: 13, originalTeam: 'ATL', currentTeam: 'PHI' }, // ATL→PHI
  { overall: 154, round: 5, roundPick: 14, originalTeam: 'BAL', currentTeam: 'BAL' },
  { overall: 155, round: 5, roundPick: 15, originalTeam: 'TB',  currentTeam: 'TB'  },
  { overall: 156, round: 5, roundPick: 16, originalTeam: 'IND', currentTeam: 'IND' },
  { overall: 157, round: 5, roundPick: 17, originalTeam: 'DET', currentTeam: 'DET' },
  { overall: 158, round: 5, roundPick: 18, originalTeam: 'MIN', currentTeam: 'CAR' }, // MIN→CAR
  { overall: 159, round: 5, roundPick: 19, originalTeam: 'CAR', currentTeam: 'CAR' },
  { overall: 160, round: 5, roundPick: 20, originalTeam: 'GB',  currentTeam: 'GB'  },
  { overall: 161, round: 5, roundPick: 21, originalTeam: 'PIT', currentTeam: 'PIT' },
  { overall: 162, round: 5, roundPick: 22, originalTeam: 'LAC', currentTeam: 'BAL' }, // LAC→BAL
  { overall: 163, round: 5, roundPick: 23, originalTeam: 'PHI', currentTeam: 'MIN' }, // PHI→MIN
  { overall: 164, round: 5, roundPick: 24, originalTeam: 'JAX', currentTeam: 'JAX' },
  { overall: 165, round: 5, roundPick: 25, originalTeam: 'CHI', currentTeam: 'BUF' }, // CHI→BUF
  { overall: 166, round: 5, roundPick: 26, originalTeam: 'SF',  currentTeam: 'JAX' }, // SF→JAX
  { overall: 167, round: 5, roundPick: 27, originalTeam: 'HOU', currentTeam: 'HOU' },
  { overall: 168, round: 5, roundPick: 28, originalTeam: 'BUF', currentTeam: 'BUF' },
  { overall: 169, round: 5, roundPick: 29, originalTeam: 'LAR', currentTeam: 'KC'  }, // LAR→KC (Trent McDuffie)
  { overall: 170, round: 5, roundPick: 30, originalTeam: 'DEN', currentTeam: 'DEN' },
  { overall: 171, round: 5, roundPick: 31, originalTeam: 'NE',  currentTeam: 'NE'  },
  { overall: 172, round: 5, roundPick: 32, originalTeam: 'SEA', currentTeam: 'NO'  }, // SEA→NO
  // Comp picks
  { overall: 173, round: 5, roundPick: 33, originalTeam: 'BAL', currentTeam: 'BAL' }, // COMP
  { overall: 174, round: 5, roundPick: 34, originalTeam: 'BAL', currentTeam: 'BAL' }, // COMP
  { overall: 175, round: 5, roundPick: 35, originalTeam: 'LV',  currentTeam: 'LV'  }, // COMP
  { overall: 176, round: 5, roundPick: 36, originalTeam: 'KC',  currentTeam: 'KC'  }, // COMP
  { overall: 177, round: 5, roundPick: 37, originalTeam: 'DAL', currentTeam: 'DAL' }, // COMP
  { overall: 178, round: 5, roundPick: 38, originalTeam: 'PHI', currentTeam: 'PHI' }, // COMP
  { overall: 179, round: 5, roundPick: 39, originalTeam: 'NYJ', currentTeam: 'NYJ' }, // COMP
  { overall: 180, round: 5, roundPick: 40, originalTeam: 'DAL', currentTeam: 'DAL' }, // COMP
  { overall: 181, round: 5, roundPick: 41, originalTeam: 'DET', currentTeam: 'DET' }, // COMP

  // ── Round 6 (35 picks — 32 standard + 3 comp) ───────────────────────────
  { overall: 182, round: 6, roundPick:  1, originalTeam: 'NYJ', currentTeam: 'BUF' }, // NYJ→BUF
  { overall: 183, round: 6, roundPick:  2, originalTeam: 'ARI', currentTeam: 'ARI' },
  { overall: 184, round: 6, roundPick:  3, originalTeam: 'TEN', currentTeam: 'TEN' },
  { overall: 185, round: 6, roundPick:  4, originalTeam: 'LV',  currentTeam: 'LV'  },
  { overall: 186, round: 6, roundPick:  5, originalTeam: 'NYG', currentTeam: 'NYG' },
  { overall: 187, round: 6, roundPick:  6, originalTeam: 'WAS', currentTeam: 'WAS' },
  { overall: 188, round: 6, roundPick:  7, originalTeam: 'CLE', currentTeam: 'SEA' }, // CLE→SEA (Nick Harris)
  { overall: 189, round: 6, roundPick:  8, originalTeam: 'CIN', currentTeam: 'CIN' },
  { overall: 190, round: 6, roundPick:  9, originalTeam: 'NO',  currentTeam: 'NO'  },
  { overall: 191, round: 6, roundPick: 10, originalTeam: 'KC',  currentTeam: 'NE'  }, // KC→NE
  { overall: 192, round: 6, roundPick: 11, originalTeam: 'MIA', currentTeam: 'NYG' }, // MIA→NYG
  { overall: 193, round: 6, roundPick: 12, originalTeam: 'DAL', currentTeam: 'NYG' }, // DAL→NYG
  { overall: 194, round: 6, roundPick: 13, originalTeam: 'BAL', currentTeam: 'TEN' }, // BAL→TEN
  { overall: 195, round: 6, roundPick: 14, originalTeam: 'TB',  currentTeam: 'TB'  },
  { overall: 196, round: 6, roundPick: 15, originalTeam: 'IND', currentTeam: 'MIN' }, // IND→MIN
  { overall: 197, round: 6, roundPick: 16, originalTeam: 'ATL', currentTeam: 'PHI' }, // ATL→PHI (Sydney Brown)
  { overall: 198, round: 6, roundPick: 17, originalTeam: 'MIN', currentTeam: 'NE'  }, // MIN→HOU→MIN→SF→NE (Cam Akers/Ed Ingram/Jordan Mason/Keion White chain)
  { overall: 199, round: 6, roundPick: 18, originalTeam: 'DET', currentTeam: 'CIN' }, // DET→CIN
  { overall: 200, round: 6, roundPick: 19, originalTeam: 'CAR', currentTeam: 'CAR' },
  { overall: 201, round: 6, roundPick: 20, originalTeam: 'GB',  currentTeam: 'GB'  },
  { overall: 202, round: 6, roundPick: 21, originalTeam: 'PIT', currentTeam: 'NE'  }, // PIT→NE
  { overall: 203, round: 6, roundPick: 22, originalTeam: 'PHI', currentTeam: 'JAX' }, // PHI→JAX
  { overall: 204, round: 6, roundPick: 23, originalTeam: 'LAC', currentTeam: 'LAC' },
  { overall: 205, round: 6, roundPick: 24, originalTeam: 'JAX', currentTeam: 'DET' }, // JAX→DET
  { overall: 206, round: 6, roundPick: 25, originalTeam: 'CHI', currentTeam: 'CLE' }, // CHI→CLE
  { overall: 207, round: 6, roundPick: 26, originalTeam: 'HOU', currentTeam: 'LAR' }, // HOU→LAR
  { overall: 208, round: 6, roundPick: 27, originalTeam: 'BUF', currentTeam: 'LV'  }, // BUF→LV
  { overall: 209, round: 6, roundPick: 28, originalTeam: 'SF',  currentTeam: 'WAS' }, // SF→WAS (Brian Robinson Jr.)
  { overall: 210, round: 6, roundPick: 29, originalTeam: 'LAR', currentTeam: 'KC'  }, // LAR→KC (Trent McDuffie)
  { overall: 211, round: 6, roundPick: 30, originalTeam: 'DEN', currentTeam: 'BAL' }, // DEN→BAL
  { overall: 212, round: 6, roundPick: 31, originalTeam: 'NE',  currentTeam: 'NE'  },
  { overall: 213, round: 6, roundPick: 32, originalTeam: 'SEA', currentTeam: 'DET' }, // SEA→DET
  // Comp picks
  { overall: 214, round: 6, roundPick: 33, originalTeam: 'PIT', currentTeam: 'IND' }, // PIT COMP→IND (Michael Pittman Jr.)
  { overall: 215, round: 6, roundPick: 34, originalTeam: 'PHI', currentTeam: 'ATL' }, // PHI COMP→ATL (Sydney Brown)
  { overall: 216, round: 6, roundPick: 35, originalTeam: 'PIT', currentTeam: 'PIT' }, // COMP

  // ── Round 7 (41 picks — 32 standard + 9 comp) ───────────────────────────
  { overall: 217, round: 7, roundPick:  1, originalTeam: 'ARI', currentTeam: 'ARI' },
  { overall: 218, round: 7, roundPick:  2, originalTeam: 'TEN', currentTeam: 'DAL' }, // TEN→DAL
  { overall: 219, round: 7, roundPick:  3, originalTeam: 'LV',  currentTeam: 'LV'  },
  { overall: 220, round: 7, roundPick:  4, originalTeam: 'NYJ', currentTeam: 'BUF' }, // NYJ→BUF
  { overall: 221, round: 7, roundPick:  5, originalTeam: 'NYG', currentTeam: 'CIN' }, // NYG→CIN
  { overall: 222, round: 7, roundPick:  6, originalTeam: 'CLE', currentTeam: 'DET' }, // CLE→DET
  { overall: 223, round: 7, roundPick:  7, originalTeam: 'WAS', currentTeam: 'WAS' },
  { overall: 224, round: 7, roundPick:  8, originalTeam: 'NO',  currentTeam: 'PIT' }, // NO→PIT
  { overall: 225, round: 7, roundPick:  9, originalTeam: 'KC',  currentTeam: 'TEN' }, // KC→TEN
  { overall: 226, round: 7, roundPick: 10, originalTeam: 'CIN', currentTeam: 'CIN' },
  { overall: 227, round: 7, roundPick: 11, originalTeam: 'MIA', currentTeam: 'MIA' },
  { overall: 228, round: 7, roundPick: 12, originalTeam: 'DAL', currentTeam: 'NYJ' }, // DAL→NYJ
  { overall: 229, round: 7, roundPick: 13, originalTeam: 'TB',  currentTeam: 'TB'  },
  { overall: 230, round: 7, roundPick: 14, originalTeam: 'IND', currentTeam: 'PIT' }, // IND→PIT (Michael Pittman Jr.)
  { overall: 231, round: 7, roundPick: 15, originalTeam: 'ATL', currentTeam: 'ATL' },
  { overall: 232, round: 7, roundPick: 16, originalTeam: 'BAL', currentTeam: 'LAR' }, // BAL→LAR
  { overall: 233, round: 7, roundPick: 17, originalTeam: 'DET', currentTeam: 'JAX' }, // DET→JAX (Aaron Glenn comp trade)
  { overall: 234, round: 7, roundPick: 18, originalTeam: 'MIN', currentTeam: 'MIN' },
  { overall: 235, round: 7, roundPick: 19, originalTeam: 'CAR', currentTeam: 'MIN' }, // CAR→MIN
  { overall: 236, round: 7, roundPick: 20, originalTeam: 'GB',  currentTeam: 'GB'  },
  { overall: 237, round: 7, roundPick: 21, originalTeam: 'PIT', currentTeam: 'PIT' },
  { overall: 238, round: 7, roundPick: 22, originalTeam: 'LAC', currentTeam: 'MIA' }, // LAC→MIA
  { overall: 239, round: 7, roundPick: 23, originalTeam: 'PHI', currentTeam: 'CHI' }, // PHI→CHI
  { overall: 240, round: 7, roundPick: 24, originalTeam: 'JAX', currentTeam: 'JAX' },
  { overall: 241, round: 7, roundPick: 25, originalTeam: 'CHI', currentTeam: 'CHI' },
  { overall: 242, round: 7, roundPick: 26, originalTeam: 'BUF', currentTeam: 'NYJ' }, // BUF→NYJ
  { overall: 243, round: 7, roundPick: 27, originalTeam: 'SF',  currentTeam: 'HOU' }, // SF→HOU
  { overall: 244, round: 7, roundPick: 28, originalTeam: 'HOU', currentTeam: 'MIN' }, // HOU→MIN
  { overall: 245, round: 7, roundPick: 29, originalTeam: 'LAR', currentTeam: 'JAX' }, // LAR→JAX
  { overall: 246, round: 7, roundPick: 30, originalTeam: 'DEN', currentTeam: 'DEN' },
  { overall: 247, round: 7, roundPick: 31, originalTeam: 'NE',  currentTeam: 'NE'  },
  { overall: 248, round: 7, roundPick: 32, originalTeam: 'SEA', currentTeam: 'CLE' }, // SEA→CLE
  // Comp picks
  { overall: 249, round: 7, roundPick: 33, originalTeam: 'IND', currentTeam: 'IND' }, // COMP
  { overall: 250, round: 7, roundPick: 34, originalTeam: 'BAL', currentTeam: 'BAL' }, // COMP
  { overall: 251, round: 7, roundPick: 35, originalTeam: 'LAR', currentTeam: 'LAR' }, // COMP
  { overall: 252, round: 7, roundPick: 36, originalTeam: 'LAR', currentTeam: 'LAR' }, // COMP
  { overall: 253, round: 7, roundPick: 37, originalTeam: 'BAL', currentTeam: 'BAL' }, // COMP
  { overall: 254, round: 7, roundPick: 38, originalTeam: 'IND', currentTeam: 'IND' }, // COMP
  { overall: 255, round: 7, roundPick: 39, originalTeam: 'GB',  currentTeam: 'GB'  }, // COMP
  { overall: 256, round: 7, roundPick: 40, originalTeam: 'DEN', currentTeam: 'DEN' }, // COMP
  { overall: 257, round: 7, roundPick: 41, originalTeam: 'DEN', currentTeam: 'DEN' }, // COMP
];

// ── Known traded future picks ────────────────────────────────────────────────
// These are applied as initial ownership overrides in DraftManager.buildFuturePickRights()

export const FUTURE_PICK_TRADES: {
  year: number; round: number; originalTeam: string; currentTeam: string;
}[] = [
  // 2027 — confirmed trades
  { year: 2027, round: 1, originalTeam: 'IND', currentTeam: 'NYJ' }, // Sauce Gardner
  { year: 2027, round: 1, originalTeam: 'GB',  currentTeam: 'DAL' }, // Micah Parsons
  { year: 2027, round: 1, originalTeam: 'DAL', currentTeam: 'NYJ' }, // Quinnen Williams (more favorable of DAL/GB picks; conditional on draft positions)
  { year: 2027, round: 1, originalTeam: 'LAR', currentTeam: 'KC'  }, // Trent McDuffie
  { year: 2027, round: 3, originalTeam: 'LAR', currentTeam: 'KC'  }, // Trent McDuffie
  { year: 2027, round: 4, originalTeam: 'MIN', currentTeam: 'CAR' }, // Adam Thielen (MIN 4th → CAR)
  { year: 2027, round: 4, originalTeam: 'DAL', currentTeam: 'GB'  }, // Rashan Gary (DAL 4th → GB)
  { year: 2027, round: 5, originalTeam: 'CAR', currentTeam: 'MIN' }, // Adam Thielen (CAR 5th → MIN)
  { year: 2027, round: 5, originalTeam: 'CHI', currentTeam: 'NE'  }, // Garrett Bradbury
  { year: 2027, round: 5, originalTeam: 'DAL', currentTeam: 'PIT' }, // George Pickens
  { year: 2027, round: 5, originalTeam: 'HOU', currentTeam: 'CLE' }, // HOU 5th → CLE (part of 2025 Cam Robinson deal)
  { year: 2027, round: 5, originalTeam: 'PIT', currentTeam: 'MIA' }, // Jalen Ramsey / Minkah Fitzpatrick (PIT 5th → MIA)
  { year: 2027, round: 6, originalTeam: 'CLE', currentTeam: 'HOU' }, // Cam Robinson (CLE 6th → HOU)
  { year: 2027, round: 6, originalTeam: 'GB',  currentTeam: 'PHI' }, // Darian Kinnard (GB 6th → PHI)
  { year: 2027, round: 6, originalTeam: 'LAC', currentTeam: 'NO'  }, // Trevor Penning (LAC 6th → NO)
  { year: 2027, round: 6, originalTeam: 'NO',  currentTeam: 'NE'  }, // Ja'Lynn Polk (NO 6th → NE)
  { year: 2027, round: 6, originalTeam: 'PIT', currentTeam: 'DAL' }, // George Pickens (PIT 6th → DAL)
  { year: 2027, round: 6, originalTeam: 'SF',  currentTeam: 'KC'  }, // Skyy Moore (SF 6th → KC)
  { year: 2027, round: 7, originalTeam: 'BAL', currentTeam: 'PHI' }, // Jaire Alexander (BAL 7th → PHI)
  { year: 2027, round: 7, originalTeam: 'HOU', currentTeam: 'CLE' }, // Cam Robinson (HOU 7th → CLE)
  { year: 2027, round: 7, originalTeam: 'KC',  currentTeam: 'SF'  }, // Skyy Moore (KC 7th → SF)
  { year: 2027, round: 7, originalTeam: 'LAR', currentTeam: 'LAC' }, // Odafe Oweh chain: LAR 7th → BAL → LAC
  { year: 2027, round: 7, originalTeam: 'MIA', currentTeam: 'PIT' }, // Jalen Ramsey reverse (MIA 7th → PIT)
  { year: 2027, round: 7, originalTeam: 'NO',  currentTeam: 'DEN' }, // Devaughn Vele (NO 7th → DEN)
  { year: 2027, round: 7, originalTeam: 'NYJ', currentTeam: 'PHI' }, // Michael Carter II / John Metchie (NYJ 7th → PHI)
  { year: 2027, round: 7, originalTeam: 'PHI', currentTeam: 'MIN' }, // Sam Howell trade (PHI 7th → MIN)
  { year: 2027, round: 7, originalTeam: 'HOU', currentTeam: 'DET' }, // David Montgomery (unconfirmed: could be LAC 7th → DET)
  // 2027 — conditional trades (PICK MAY OR MAY NOT TRANSFER)
  { year: 2027, round: 6, originalTeam: 'KC',  currentTeam: 'NYJ' }, // Derrick Nnadi: KC conditional 6th → NYJ (conditions unknown)
  { year: 2027, round: 6, originalTeam: 'NYJ', currentTeam: 'MIN' }, // Harrison Phillips: NYJ or KC 6th → MIN (unconfirmed which team's pick)
  { year: 2027, round: 7, originalTeam: 'MIN', currentTeam: 'KC'  }, // Derrick Nnadi: MIN conditional 7th → KC via NYJ (conditions unknown)
  { year: 2027, round: 7, originalTeam: 'MIA', currentTeam: 'NYG' }, // Darren Waller: MIA conditional 7th → NYG (conditions unknown)
  { year: 2027, round: 7, originalTeam: 'SEA', currentTeam: 'ATL' }, // Michael Jerrell: SEA conditional 7th → ATL (conditions unknown)
  // 2028 — confirmed trades
  { year: 2028, round: 6, originalTeam: 'HOU', currentTeam: 'NO'  }, // Kai Kroeger (HOU 6th → NO)
  { year: 2028, round: 6, originalTeam: 'NO',  currentTeam: 'DAL' }, // Asim Richards (NO 6th → DAL)
  { year: 2028, round: 7, originalTeam: 'CLE', currentTeam: 'LAR' }, // K.T. Leveston (CLE 7th → LAR)
  { year: 2028, round: 7, originalTeam: 'DAL', currentTeam: 'NO'  }, // Asim Richards reverse (DAL 7th → NO)
  { year: 2028, round: 7, originalTeam: 'NE',  currentTeam: 'NO'  }, // Ja'Lynn Polk (NE 7th → NO)
  { year: 2028, round: 7, originalTeam: 'NO',  currentTeam: 'HOU' }, // Kai Kroeger (NO 7th → HOU)
  // 2028 — conditional trades (PICK MAY OR MAY NOT TRANSFER)
  { year: 2028, round: 7, originalTeam: 'LAC', currentTeam: 'NYJ' }, // Ja'Sir Taylor: LAC conditional 7th → NYJ (conditions unknown)
];
