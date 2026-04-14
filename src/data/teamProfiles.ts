/**
 * Enhanced strategy prompts for all 32 NFL teams.
 * Used by SmartAutopick when no user-defined strategy exists.
 *
 * Each prompt includes: 2026 positional needs (priority-ordered), named prospect
 * targets, coaching staff context (especially for the 10 new HCs), GM draft
 * philosophy, available draft capital, scheme-fit considerations, and roster
 * context that should influence pick decisions.
 *
 * Sourced from the LLM Wiki: 2026 NFL Draft Team Needs, 2026 Draft Intel and
 * Predictions, 2026 Coaching Carousel, GM Trade Style Taxonomy, and 32 GM pages.
 *
 * Drop-in replacement for MockDraftBot's src/data/teamProfiles.ts.
 */

export const DEFAULT_STRATEGY_PROMPTS: Record<string, string> = {

  // ══════════════════════════════════════════════════════════════════════════
  // AFC EAST
  // ══════════════════════════════════════════════════════════════════════════

  'BUF': `TEAM: Buffalo Bills | GM: Beane (opportunist) | HC: Joe Brady (new 2026)
NEEDS: EDGE > LB > WR > DT > CB. Safety/LB ranked 22nd PFF.
TARGETS: Jaishawn Barham (EDGE, Michigan).
CAPITAL: Standard. Championship window — every pick must contribute now.
SCHEME: Jim Leonhard as new DC — defensive adaptation needed.
RULES: BPA over need. Trade back when 5-7 players cluster. Pick NFL-ready defenders, not projects.
AVOID: Reaching for positional need. Trading up unless a solo-tier talent falls.`,

  'MIA': `TEAM: Miami Dolphins | GM: Jon-Eric Sullivan (first-year) | HC: Jeff Hafley (new 2026, defensive background)
NEEDS: WR > OL > CB > S. Receiver group gutted — Hill and Waddle gone. Malik Willis needs weapons. Secondary has no premium talent.
CAPITAL: Seven top-100 picks — most capital-rich draft in years. Full rebuild.
SCHEME: OC Bobby Slowik, DC Sean Duggan.
RULES: Use all seven top-100 picks on starters — volume over consolidation. WR early and often. OL and secondary mid-rounds. Target culture guys.
AVOID: Trading up to consolidate picks. Ignoring WR in Round 1.`,

  'NE': `TEAM: New England Patriots | GM: Eliot Wolf (Dir. of Scouting, final call) | HC: Mike Vrabel (king coach, defensive background)
NEEDS: WR > OL > EDGE > S. Drake Maye needs weapons and OL depth.
RULES: Balanced approach — open to trading either direction. Prioritize NFL-ready players who support Maye's development. Value versatility and football IQ over pure athleticism.
AVOID: Neglecting offensive support for Maye. Prioritizing flash over reliability.`,

  'NYJ': `TEAM: New York Jets | GM: Darren Mougey (most aggressive roster-turner in NFL) | HC: TBD
NEEDS: EDGE > WR > QB (long-term). Defense ranked 31st EPA allowed; zero INTs all season. Geno Smith is bridge QB only.
TARGETS: David Bailey (EDGE, Texas Tech — pro-ready) or Arvell Reese (LB/EDGE, Ohio State — higher ceiling) at No. 2. Omar Cooper Jr. (WR, Indiana) — reported to be extremely high on him.
CAPITAL: Two 1sts this year, three 1sts next year. Full rebuild capital.
RULES: EDGE at No. 2 is non-negotiable — historically bad defense. Take BPA and worry about scheme fit later. Accumulate picks aggressively via salary-dump trades.
AVOID: Overthinking scheme fit during a scorched-earth rebuild.`,

  // ══════════════════════════════════════════════════════════════════════════
  // AFC NORTH
  // ══════════════════════════════════════════════════════════════════════════

  'BAL': `TEAM: Baltimore Ravens | GM: DeCosta (premier pick accumulator) | HC: Jesse Minter (new 2026, first-time HC)
NEEDS: WR > TE > C > DT. Lamar needs a true No. 1 — Flowers/Bateman/Walker insufficient. Lost Linderbaum (C) and Likely (TE).
SCHEME: OC Declan Doyle, DC Anthony Weaver. Run-heavy identity — physical, athletic players only.
RULES: WR early — Lamar's passing game is desperate. Trade back when equal-tier players cluster; maximize at-bats. Quantity over individual pick quality.
AVOID: Paying a premium to move up. Drafting finesse players who don't fit the Ravens' identity.`,

  'CIN': `TEAM: Cincinnati Bengals | GM: Duke Tobin (conservative, 2022 Exec of Year)
NEEDS: DT > OT > slot WR > S. Second-worst overall defense.
TARGETS: Mansoor Delane (CB, LSU) — "most certain" non-No. 1 pick at No. 10 (Field Yates). Caleb Downs (S) and Peter Woods (DT) also ideal.
RULES: Stay put or make small moves. Draft-develop-retain model. Pick high-floor contributors who help the 2026 roster. Super Bowl window is now.
AVOID: Major draft-day trades. Developmental projects. Reaching for need.`,

  'CLE': `TEAM: Cleveland Browns | GM: Andrew Berry (analytics-driven accumulator) | HC: Todd Monken (new 2026, ex-Ravens OC)
NEEDS: LT > WR > EDGE > QB. Two 1sts (6 and 24) to address tackle and receiver.
TARGETS: Carnell Tate (WR) frequently linked. Monken hired to develop a QB — possibly from this draft.
CAPITAL: No. 6 and No. 24. Significant flexibility for trade-back sequences.
SCHEME: OC Travis Switzer, DC Mike Rutenberg.
RULES: LT at No. 6 if a top tackle is there. WR or EDGE at No. 24. Trade back from No. 6 if the board falls flat — Berry sees surplus value in late 1st/early 2nd.
AVOID: Reaching at No. 6 for positional need. Ignoring trade-back value when players cluster.`,

  'PIT': `TEAM: Pittsburgh Steelers | GM: Omar Khan (aggressive maneuverer) | HC: Mike McCarthy (new 2026, Super Bowl winner)
NEEDS: QB > WR > G > CB > S. Receiving corps ranked 29th despite adding Metcalf.
TARGETS: Ty Simpson (QB, Alabama). Jordyn Tyson (WR, Arizona State) — "screams Steelers receiver" but hamstring/drop concerns.
CAPITAL: Five top-100 picks including three in Round 3. Trade-up ammunition.
SCHEME: OC Brian Angelichio, DC Patrick Graham. McCarthy's offensive mind pushes skill-position investment.
RULES: Package picks to trade up for a coveted WR or QB. Prioritize WR to complement Metcalf. G and secondary mid-rounds.
AVOID: Sitting on five top-100 picks without consolidating for premium talent.`,

  // ══════════════════════════════════════════════════════════════════════════
  // AFC SOUTH
  // ══════════════════════════════════════════════════════════════════════════

  'HOU': `TEAM: Houston Texans | GM: Caserio (most active draft-day trader, 25 trades since 2021) | HC: TBD
NEEDS: OL depth > WR. OL starters aging (Teller turning 32). WR to support C.J. Stroud.
CAPITAL: Standard. Contending team — picks must enhance championship roster.
RULES: Rank board vertically by talent, then evaluate positional need horizontally. Move around the board via trades to find value. Pick NFL-ready OL and WR contributors.
AVOID: Reaching when high trade volume enables board navigation. Drafting projects on a win-now roster.`,

  'IND': `TEAM: Indianapolis Colts | GM: Chris Ballard (conservative, draft-and-retain) | HC: TBD
NEEDS: EDGE > CB > OL. Injuries buried 2025. Anthony Richardson stalling; Daniel Jones added for competition.
RULES: Draft at assigned slot — Ballard rarely trades and demands overpay to move. BPA is genuinely correct when talent is needed everywhere. High-floor, immediate contributors only — Ballard needs wins to save his job.
AVOID: Trading down aggressively. Risky developmental projects. Reaching for positional need.`,

  'JAX': `TEAM: Jacksonville Jaguars | GM: James Gladstone (youngest current GM) | HC: TBD
NEEDS: LB > EDGE > RB. Lost Pro Bowler Devin Lloyd (LB) to Panthers. Need EDGE to complement Hines-Allen. RB depth after Etienne's departure.
CAPITAL: Standard. Coming off 13-4 division title — reload, not rebuild.
RULES: LB is priority one — Lloyd's departure is a massive hole. EDGE for defensive front. RB mid-rounds. Be aggressive when conviction is high; use smokescreens effectively.
AVOID: Treating this as a rebuild. Ignoring LB in favor of BPA at a non-need position.`,

  'TEN': `TEAM: Tennessee Titans | GM: Mike Borgonzi (first-year, Chiefs org) | HC: Robert Saleh (new 2026)
NEEDS: OT > RB > EDGE. Allowed 56 sacks — need a tackle to pair with JC Latham.
TARGETS: Jeremiyah Love (RB, Notre Dame) linked at No. 4. David Bailey (EDGE) and Sonny Styles (LB) also in play.
CAPITAL: No. 4 overall. Significant cap flexibility.
SCHEME: Transitioning 3-4 to 4-3 under Saleh/Gus Bradley. OC Brian Daboll. Need 4-3 personnel — athletic edge rushers, coverage LBs.
RULES: OT at No. 4 if a premium tackle is available — 56 sacks is unacceptable. Pivot to EDGE/LB if top tackles gone. Build long-term around Cam Ward.
AVOID: Taking RB at No. 4 over a franchise tackle. Drafting 3-4 personnel for a 4-3 scheme.`,

  // ══════════════════════════════════════════════════════════════════════════
  // AFC WEST
  // ══════════════════════════════════════════════════════════════════════════

  'DEN': `TEAM: Denver Broncos | GM: George Paton (pick accumulator) | HC: Sean Payton (king coach)
NEEDS: WR depth > RB. No glaring needs. Waddle acquired but another weapon for Bo Nix pushes offense to elite. RB depth after Dobbins injury struggles.
CAPITAL: Standard. Luxury draft — good roster pushing toward great.
RULES: Trade back from premium spots to accumulate Day 2 picks. WR to complement Waddle as a third weapon. RB mid-rounds for depth.
AVOID: Forcing a pick at a position of strength. Trading up (Payton's instinct) when Paton's trade-back sequences yield more value.`,

  'KC': `TEAM: Kansas City Chiefs | GM: Brett Veach (aggressive, adapts to board) | HC: Andy Reid (king coach)
NEEDS: CB > RB > OL > EDGE. Secondary exodus at cornerback. Rushing game bottom-3 in 10+ yard runs. Pacheco and Hunt entering FA.
TARGETS: Kenyon Sadiq (TE) as Kelce succession plan at No. 9.
CAPITAL: Two 1sts (No. 9 and No. 29) — first top-10 pick since Mahomes trade-up in 2017.
RULES: CB at No. 9 to fix secondary, or take elite BPA if one falls. No. 29 for RB/OL/EDGE depth. Reid's system maximizes mid-round talent — no need to overpay. Championship roster — maintain dynasty window.
AVOID: Overpaying to trade up when Reid's development pipeline works. Ignoring the rushing game.`,

  'LV': `TEAM: Las Vegas Raiders | GM: John Spytek | HC: Klint Kubiak (new 2026, first-time HC)
NEEDS: QB > WR > OL > DT. No. 1 pick on Fernando Mendoza, then build around him.
TARGETS: Fernando Mendoza (QB, Indiana) at No. 1 — universal consensus.
CAPITAL: No. 1 overall pick.
SCHEME: Kubiak's offense shifts to high air yards and frequent receiver targeting — WR and OL critical.
RULES: Mendoza at No. 1 unless an overwhelming trade-down premium arrives. Every subsequent pick builds infrastructure: OL to protect, WR to target, DT to shore up defense. Pick NFL-ready players only.
AVOID: Trading down from No. 1 without an overwhelming premium. Drafting projects — Mendoza needs immediate contributors.`,

  'LAC': `TEAM: Los Angeles Chargers | GM: Joe Hortiz (Ravens-trained, BPA + trench-first) | HC: Jim Harbaugh
NEEDS: OL > WR. Playoff losses exposed OL weakness. Need another receiver for Herbert.
RULES: OL first — protecting Herbert is paramount. BPA with strong bias toward offensive and defensive lines. Physical, tough players who fit Ravens-influenced identity. Every pick should close the gap between regular-season success and postseason advancement.
AVOID: Reaching for flashy skill-position players over solid trench talent. Ignoring the OL problems exposed in playoffs.`,

  // ══════════════════════════════════════════════════════════════════════════
  // NFC EAST
  // ══════════════════════════════════════════════════════════════════════════

  'DAL': `TEAM: Dallas Cowboys | GM: Jerry Jones (McClay runs draft board) | HC: TBD
NEEDS: CB > S > RB. Worst passing defense in the league over two seasons. Parsons returning from ACL; Rashan Gary signed.
CAPITAL: Two 1sts (No. 14 and No. 20). Both should target secondary.
RULES: CB at one 1st, S at the other — secondary is historically bad and must be fixed. RB mid-rounds. Trust film over combine numbers (McClay's approach). Stay put or make small moves down.
AVOID: Splitting 1st-round picks across positions when secondary is this dire. Reaching for need — let the board dictate order of CB vs S.`,

  'NYG': `TEAM: New York Giants | GM: Joe Schoen (balanced/opportunistic, Bills-trained) | HC: John Harbaugh (new 2026, Super Bowl winner)
NEEDS: OT > OL interior > WR. RT is priority — Eluemunor entering FA. Andrew Thomas (90.3 PFF) is the only reliable lineman. Need WR beyond Nabers.
TARGETS: Francis Mauigoa (OT, Miami) projected at No. 5. Sonny Styles as BPA pivot.
CAPITAL: No. 5 overall.
SCHEME: OC Matt Nagy, DC Dennard Wilson. Harbaugh wants fewer 11-personnel sets, run-game emphasis — OL investment critical.
RULES: OT at No. 5 for a franchise RT to pair with Thomas. If top tackles gone, take Styles as BPA. WR mid-rounds. Value physical, road-grading linemen for run scheme. Build inside-out around Jaxson Dart.
AVOID: Drafting finesse pass protectors over run-game maulers. Reaching for WR when OL is the foundation.`,

  'PHI': `TEAM: Philadelphia Eagles | GM: Howie Roseman (NFL's most aggressive draft-day trader, 49+ draft-day trades) | HC: Nick Sirianni
NEEDS: EDGE > WR > TE > OL. Lost Sweat and Phillips — pass rush depleted. WR urgent if A.J. Brown traded. Goedert entering age-31 season.
CAPITAL: Eight picks this draft, 20 over next two years. Unmatched flexibility.
RULES: Trade up aggressively — Roseman's priority order: (1) trade up, (2) stay put, (3) trade back, (4) trade for veteran. EDGE first. Build from trenches out. Take BPA and trust talent finds a role.
AVOID: Passively staying put — Roseman was frustrated by failed trade-up attempts in 2025 and will be aggressive. Ignoring pass rush.`,

  'WAS': `TEAM: Washington Commanders | GM: Adam Peters (BPA-first, 49ers/Broncos background) | HC: Dan Quinn
NEEDS: WR > IDL > CB. Need weapons around Daniels beyond McLaurin. Defense ranked 31st EPA allowed. $73.65M cap space.
CAPITAL: Only three picks in top 150 — severely capital-limited.
RULES: BPA at No. 7 regardless of position if elite talent falls. Trade down from No. 7 for volume if board is flat — too many needs for one pick to solve. Target scheme-versatile defenders and physical offensive players.
AVOID: Forcing a positional pick at No. 7 when the roster needs talent everywhere. Staying at No. 7 if no elite prospect is available.`,

  // ══════════════════════════════════════════════════════════════════════════
  // NFC NORTH
  // ══════════════════════════════════════════════════════════════════════════

  'CHI': `TEAM: Chicago Bears | GM: Ryan Poles (pick accumulator, BPA) | HC: Ben Johnson
NEEDS: C > WR > defense. Dalman's sudden retirement removes 8th-highest-graded center. Bradbury added as bridge. Lost DJ Moore to Buffalo.
RULES: Center is crisis-level need. WR to replace Moore's production. Trade back to accumulate mid-round picks where surplus value peaks. Take BPA even if C/WR isn't the top player — address C later if needed. High-floor Year 1 starters only.
AVOID: Overpaying to trade up. Forcing a center pick over a clearly superior BPA.`,

  'DET': `TEAM: Detroit Lions | GM: Brad Holmes (wild card — trades up 20 spots or down from top 10) | HC: Dan Campbell
NEEDS: LT > DE. Taylor Decker replacement is the biggest roster question. Need DE across from Aidan Hutchinson. Band-aid signings (Borom, Wonnum) on 1-year deals.
CAPITAL: Only two top-100 picks (No. 17 and No. 50). Every pick must hit.
RULES: LT at No. 17 if a starting-caliber tackle is available. DE at No. 50 or via trade-up. Value competitive, high-motor players who fit Campbell's culture. If elite talent at another position falls to 17, take it.
AVOID: Wasting either top-100 pick on a non-contributor. Reaching for need when BPA and need likely align anyway.`,

  'GB': `TEAM: Green Bay Packers | GM: Brian Gutekunst (aggressive trader, 13 draft-day trades) | HC: Matt LaFleur
NEEDS: EDGE > CB > depth. Traded 2026 1st for Micah Parsons. Parsons and Wyatt returning from season-ending injuries. Van Ness awaiting breakout.
CAPITAL: No first-round pick. Depth-and-development mission.
RULES: EDGE and CB in Round 2. Target athletic, scheme-versatile players who contribute behind current starters. Day 2 and 3 for defensive depth and special teams.
AVOID: Ignoring the urge to trade back into late Round 1 — Gutekunst's aggressive instinct may fire if a player he loves falls. Reaching for starters when depth is the realistic mission.`,

  'MIN': `TEAM: Minnesota Vikings | GM: Rob Brzezinski (interim EVP, cautious institutional approach)
NEEDS: C > DT > RB. Ryan Kelly retired — no obvious replacement. DT reinforcement needed. Rushing attack lackluster.
SCHEME: McCarthy's emergence means QB is set — build around him with blocking and a run game.
RULES: Center is the most pressing need. Stay the course — no bold moves from an interim GM. Lean on scouting staff. Take safest, highest-floor players available. BPA with slight lean toward C/DT/RB.
AVOID: Aggressive trade-ups. Risky reaches. Any move that looks like an interim GM overstepping.`,

  // ══════════════════════════════════════════════════════════════════════════
  // NFC SOUTH
  // ══════════════════════════════════════════════════════════════════════════

  'ATL': `TEAM: Atlanta Falcons | GM: Ian Cunningham (first-year, BAL/PHI/CHI background) | HC: Kevin Stefanski (new 2026, two-time COTY)
NEEDS: WR depth > IDL. Drake London is elite but no other receiver earned 60.0+ PFF grade. IDL reinforcement needed.
SCHEME: Stefanski's system will maximize Penix Jr.
RULES: WR first — London needs a legitimate running mate. IDL mid-rounds. Smart, low-risk picks to establish GM identity. Scheme-fit players for Stefanski's system. NFL-ready contributors over projects.
AVOID: Overhauling a talented 8-9 roster. Taking high-risk swings in a first-year GM's debut draft.`,

  'CAR': `TEAM: Carolina Panthers | GM: Dan Morgan (aggressive drafter, Beane-trained) | HC: Dave Canales
NEEDS: TE > C > EDGE. Bryce Young needs a pass-catching TE. Center competition needed. Pass rush upgrades.
RULES: TE for Bryce Young's middle-of-field weapon. C for OL stability. EDGE for pass rush. Be aggressive when the board demands it but let Tilis (assistant GM) provide analytical restraint. Every pick should be a long-term starter, not a stopgap.
AVOID: Overpaying to trade up (traded up twice in 2025 already). Reaches over board-appropriate BPA.`,

  'NO': `TEAM: New Orleans Saints | GM: Mickey Loomis (longest-tenured active GM, aggressive trade-up tendencies) | HC: TBD
NEEDS: RB > WR. Need long-term Kamara replacement. WR running mate for Olave to support second-year QB Tyler Shough.
RULES: RB if an elite back is available. WR to pair with Olave. Trade up if a top RB/WR falls past expectations — Loomis will pay the premium. Build the supporting cast around Shough: skill-position weapons first.
AVOID: Defensive picks when the offense around a second-year QB needs all the help. Passing on a falling RB/WR to stay put.`,

  'TB': `TEAM: Tampa Bay Buccaneers | GM: Jason Licht (since 2014, NFL-best homegrown talent production) | HC: TBD
NEEDS: EDGE > LB. Lowest sack total since 2017 — pass rush historically bad.
RULES: EDGE is non-negotiable priority. LB for defensive depth. Can take higher-upside prospects — Licht's development pipeline will maximize them. Target athletic, high-motor defenders with pass-rush upside. Mid-round picks for depth and special teams.
AVOID: Reaching for need — EDGE/LB will likely be BPA anyway. Ignoring the pass rush for offensive luxury picks.`,

  // ══════════════════════════════════════════════════════════════════════════
  // NFC WEST
  // ══════════════════════════════════════════════════════════════════════════

  'ARI': `TEAM: Arizona Cardinals | GM: Monti Ossenfort (conservative, draft-and-develop) | HC: Mike LaFleur (new 2026)
NEEDS: RT > EDGE > QB. Hit reset at QB after parting with Kyler Murray. OL right side and defensive front are major needs.
TARGETS: No. 3 pick "far more likely" RT or Arvell Reese (LB/EDGE, Ohio State) than a QB. Schrager projects Reese.
CAPITAL: No. 3 overall.
RULES: RT at No. 3 if a franchise tackle is available. Reese as defensive playmaker if top tackles gone. Stay put and take BPA — Ossenfort doesn't make deals weeks in advance. Trust the board.
AVOID: Reaching for a QB who isn't a top-tier guy. Trading down from No. 3 without overwhelming value.`,

  'LAR': `TEAM: Los Angeles Rams | GM: Les Snead (aggressive both directions) | HC: Sean McVay (king coach)
NEEDS: WR3 > depth. Perhaps fewest weaknesses of any NFL team. Ranked 1st in offensive (93.0) and defensive (86.8) PFF grade. Need dependable third receiver behind Nacua and Adams.
CAPITAL: No. 29. May trade for veteran talent (e.g., Trent McDuffie floated).
RULES: WR3 if one is clearly available. If not, trade back for multiple Day 2 picks or trade No. 29 for a veteran contributor. Luxury draft for a championship roster — depth at positions of strength.
AVOID: Forcing a pick when trading the pick for a veteran may be smarter. Drafting for need on a roster this complete.`,

  'SF': `TEAM: San Francisco 49ers | GM: John Lynch | HC: Kyle Shanahan (king coach)
NEEDS: LT > WR. Trent Williams successor is the most critical need. Brock Purdy unsigned.
TARGETS: Scheduled 30 visits with four receivers (Concepcion, Cooper Jr., Boston, Hudson) — all strong after-the-catch producers. Signals heavy WR interest.
SCHEME: YAC-heavy, run-first, outside-zone blocking. WR must create after the catch. LT must be a physical road-grader who fits outside zone.
RULES: LT first — Williams' replacement is existential. WR second — target YAC-scheme fits, not vertical-only receivers. BPA with strong lean toward LT and WR.
AVOID: Drafting finesse receivers who don't fit the YAC scheme. Ignoring LT for a flashier pick.`,

  'SEA': `TEAM: Seattle Seahawks | GM: John Schneider (74 trades over 16 drafts, high-volume accumulator) | HC: Mike Macdonald
NEEDS: RG > RB. Kenneth Walker III departed for Chiefs. Charbonnet rehabbing. Need starting-caliber RG for Darnold's second year.
RULES: RG first — OL needs a starter. RB to replace Walker's production. Trade back and accumulate picks if the board is flat. Target physical, competitive, high-motor players. Depth draft: fill RG and RB, then add depth across roster mid-rounds.
AVOID: Staying put when trading back yields more volume. Drafting finesse players over competitors.`,
};
