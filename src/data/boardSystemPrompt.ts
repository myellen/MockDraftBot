/**
 * Enriched board-ai system prompt with wiki-sourced draft intelligence.
 *
 * To integrate: replace the return statement body in board-ai.ts's
 * buildBoardSystemPrompt() with this content, interpolating the same
 * runtime variables (teamName, teamAbbr, prospectsStr, boardStr, etc.)
 */

// This file contains the enriched prompt text blocks to be injected into
// board-ai.ts's buildBoardSystemPrompt() function.

/**
 * Team-specific draft intelligence keyed by team abbreviation.
 * Inject after "## Current Draft Strategy" in the board-ai system prompt.
 */
export const TEAM_DRAFT_INTEL: Record<string, string> = {
  // ── AFC EAST ──────────────────────────────────────────────────────────
  BUF: `NEEDS: EDGE > LB > WR > DT > CB. Safety/LB 22nd PFF.
GM: Beane — opportunist, patient, trades back when board clusters.
TARGETS: Barham (EDGE, Michigan).
HC: Joe Brady (new 2025) — offensive creativity, defensive roster investment this draft.
CAPITAL: Standard. No surplus early picks.`,

  MIA: `NEEDS: WR > OL > CB > S. Hill and Waddle both departed — WR corps gutted.
GM: Sullivan — builder, volume-focused, maximizes every pick.
CAPITAL: 7 top-100 picks — most in the league. Spread across WR, OL, secondary.
HC: Jeff Hafley (new, DB specialist) — secondary investment likely.`,

  NE: `NEEDS: WR > OL > EDGE > S. Build around Drake Maye.
GM: Wolf — balanced, consensus-driven.
HC: Vrabel ("king coach") — commands roster authority, heavily influences picks.
CAPITAL: Standard. Prioritize OL and WR early for Maye's development window.`,

  NYJ: `NEEDS: EDGE > WR > QB (long-term). No. 2 overall pick.
PICK 2: Bailey (EDGE, Texas Tech) vs Reese (LB/EDGE, Ohio State) — 50/50.
TARGETS: Cooper Jr. (WR, Indiana).
GM: Mougey — aggressive. Two 1sts (2026), three 1sts (2027) for trade leverage.`,

  // ── AFC NORTH ─────────────────────────────────────────────────────────
  BAL: `NEEDS: WR > TE > C > DT. Lamar needs weapons. Lost Linderbaum (C) and Likely (TE).
GM: DeCosta — accumulates picks, trades back to stockpile Day 2 capital.
HC: Jesse Minter (promoted from DC) — defensive continuity, offensive needs dominate draft.
CAPITAL: Standard. Will trade down if early-pick value isn't there.`,

  CIN: `NEEDS: DT > OT > slot WR > S. 2nd-worst defense in NFL.
PICK 10: Delane (CB, LSU) — "most certain" non-No. 1 pick per insider intel.
GM: Tobin — conservative, does not trade up or down. Takes the board as it falls.
CAPITAL: Standard at pick 10. Will not move from this spot.`,

  CLE: `NEEDS: LT > WR > EDGE > QB. Picks 6 and 24.
TARGETS: Carnell Tate (WR).
GM: Berry — accumulator, flexible. May package 6+24 to move up, or split value.
HC: Todd Monken (new, former OC) — offensive scheme overhaul, prioritize skill + OL.
CAPITAL: Picks 6 and 24 R1. Can consolidate or diversify.`,

  PIT: `NEEDS: QB > WR > G > CB > S. WR unit 29th in NFL.
TARGETS: Ty Simpson (QB), Jordyn Tyson (WR, ASU) — note: Tyson may fall (hamstring, drops).
GM: Khan — aggressive, trades up. FIVE top-100 picks as currency.
HC: Mike McCarthy — established offensive mind, pushes for QB and WR early.
CAPITAL: 5 top-100 picks. Most likely trade-up team in the draft.`,

  // ── AFC SOUTH ─────────────────────────────────────────────────────────
  HOU: `NEEDS: OL depth > WR. Contender built around Stroud — marginal needs only.
GM: Caserio — most active draft-day trader in NFL (25 trades since 2021).
HC: Continuity. Win-now roster needing depth, not foundational pieces.
CAPITAL: Standard. Caserio will trade frequently regardless of pick position.`,

  IND: `NEEDS: EDGE > CB > OL. Anthony Richardson's development stalling — supporting cast matters.
GM: Ballard — conservative, draft-and-retain. Final contract year — pressure to perform.
HC: Continuity. Ballard's job security adds urgency; may deviate from usual patience.
CAPITAL: Standard. Historically avoids trades but desperation could shift behavior.`,

  JAX: `NEEDS: LB > EDGE > RB. Lost Devin Lloyd (LB) — replacement needed.
GM: Gladstone — young, balanced-opportunistic. First draft as lead decision-maker.
CONTEXT: 13-4 team. Contender filling gaps, not rebuilding.
CAPITAL: Standard. May be cautious in first draft but has support to be bold.`,

  TEN: `NEEDS: OT > RB > EDGE. No. 4 overall pick. Allowed 56 sacks — worst OL in NFL.
TARGETS: Jeremiyah Love (RB).
HC: Robert Saleh (new) — transitioning to 4-3 defense, EDGE scheme fit gains priority.
GM: Borgonzi (from Chiefs) — first-year GM, Chiefs pedigree suggests BPA with positional value.
CAPITAL: No. 4 pick. OT at 4 is the obvious play unless trade-back offer is too good.`,

  // ── AFC WEST ──────────────────────────────────────────────────────────
  DEN: `NEEDS: WR depth > RB. No glaring holes — luxury position.
GM: Paton wants to trade back. HC: Payton ("king coach") wants to trade up. Internal tension.
CONTEXT: Paton-Payton conflict means unpredictable draft-day decisions. Flag both directions.
CAPITAL: Standard. BPA is correct approach given no urgent needs.`,

  KC: `NEEDS: CB > RB > OL > EDGE. Picks 9 and 29.
TARGETS: Kenyon Sadiq (TE, Michigan) rumored at 9 — but CB exodus makes corner smarter.
GM: Veach — aggressive, rarely has this much early capital. Has never picked this high.
CAPITAL: Picks 9 and 29 R1. May package 29 to move up if a target falls.`,

  LV: `NEEDS: QB > WR > OL > DT. No. 1 overall pick.
PICK 1: Fernando Mendoza (QB, Indiana) — universal consensus.
HC: Klint Kubiak (new) — zone-run scheme, needs OL to execute. QB1 comes first.
GM: Spytek — first-year GM, will follow consensus.
CAPITAL: No. 1 pick + standard later rounds. After Mendoza, pivot to OL and WR.`,

  LAC: `NEEDS: OL > WR. Playoff OL concerns exposed in postseason.
GM: Hortiz (Ravens tree) — BPA-oriented, trench-first philosophy.
HC: Harbaugh reinforces trench-first mentality. OL early and often.
CAPITAL: Standard. GM/HC aligned on OL priority.`,

  // ── NFC EAST ──────────────────────────────────────────────────────────
  DAL: `NEEDS: CB > S > secondary > RB. Worst pass defense two consecutive years.
GM: Jones/McClay — conservative-ish, follow the board, no dramatic trades.
CAPITAL: Picks 14 and 20 R1. Double-dip secondary is the obvious play. RB Day 2.`,

  NYG: `NEEDS: OT > OL > WR. No. 5 overall pick.
TARGETS: Ersery or another top OT projected at 5 — OL is the clear play.
HC: John Harbaugh (new) — run-game emphasis, OL investment non-negotiable.
GM: Schoen (Bills tree) — methodical, value-driven. OT need is overwhelming.
CAPITAL: No. 5 pick. OT at 5 is the baseline unless a generational talent falls.`,

  PHI: `NEEDS: EDGE > WR > TE > OL. Lost Sweat and Reddick — EDGE gutted.
GM: Roseman — most aggressive GM in NFL, "the ultimate opportunist on draft day."
CAPITAL: 8 picks (2026), 20 total over 2 years. Will aggressively package to trade up for EDGE.
CONTEXT: If an EDGE falls, expect Roseman to pounce.`,

  WAS: `NEEDS: WR > IDL > CB. Only 3 picks in top 150 — very limited capital.
GM: Peters — BPA-first regardless of position at 7.
CAPITAL: 3 top-150 picks is dangerously thin. May trade down from 7 to accumulate.
CONTEXT: $73.65M cap space provides FA flexibility that reduces draft urgency.`,

  // ── NFC NORTH ─────────────────────────────────────────────────────────
  CHI: `NEEDS: C > WR > defense. Dalman retired, DJ Moore departed — two starters gone.
GM: Poles — accumulates mid-round picks, quantity over quality.
HC: Continuity. Offensive needs dominate but Poles spreads picks across both sides.
CAPITAL: Standard, skewed mid-rounds. Poles' strength is Day 2/3 value.`,

  DET: `NEEDS: LT > DE. Only picks 17 and 50 in first two rounds — extremely limited.
CONTEXT: Decker replacement at LT is critical — single most important pick.
GM: Holmes — "wild card directionally," unpredictable on trade-up vs stand pat.
CAPITAL: Picks 17 and 50 only. LT at 17 near-mandatory. DE at 50 or trade back from 17.`,

  GB: `NEEDS: EDGE > CB > depth. No 1st-round pick — traded for Micah Parsons.
GM: Gutekunst — aggressive but zero R1 capital this year. Day 2 is everything.
CAPITAL: No 1st-round pick. Must maximize R2-4 for EDGE and CB.`,

  MIN: `NEEDS: C > DT > RB. Joe Kelly retired — center is top priority.
GM: Brzezinski — interim GM, cautious approach. Conservative, by-the-book drafting.
CONTEXT: J.J. McCarthy emerging at QB provides stability. Build around him with interior OL and run game.
CAPITAL: Standard.`,

  // ── NFC SOUTH ─────────────────────────────────────────────────────────
  ATL: `NEEDS: WR depth > IDL. Drake London elite but no credible WR2.
HC: Stefanski (new). GM: Cunningham (new). Complete leadership overhaul.
CONTEXT: 8-9 roster — transitional draft, not rebuilding or contending.
CAPITAL: Standard. New leadership may prioritize "their guys" over pure BPA.`,

  CAR: `NEEDS: TE > C > EDGE. Build around Bryce Young — weapons and protection.
GM: Morgan — aggressive, but OC Evero provides restraint and balance.
CAPITAL: Standard. TE is the biggest gap. C and EDGE Day 2.`,

  NO: `NEEDS: RB > WR. Kamara aging — need a successor. Support Tyler Shough at QB.
GM: Loomis — aggressive trade-up tendencies. Will move up if a RB/WR he loves slides.
CAPITAL: Standard, but Loomis historically mortgages future picks. Future capital is thin.`,

  TB: `NEEDS: EDGE > LB. Lowest sack total since 2017 — pass rush non-existent.
GM: Licht — values homegrown talent, deal-making. Sweet spot is R2-3.
CAPITAL: Standard. EDGE R1 near-mandatory given sack drought. LB Day 2.`,

  // ── NFC WEST ──────────────────────────────────────────────────────────
  ARI: `NEEDS: RT > EDGE > QB. No. 3 overall pick. Insider intel: "far more likely" RT or LB than QB.
HC: Matt LaFleur (new) — offensive scheme requires elite OL. RT at 3 fits.
GM: Ossenfort — conservative, takes safe high-floor pick.
CAPITAL: No. 3 pick. RT at 3 is baseline.`,

  LAR: `NEEDS: WR3 > depth. "Fewest weaknesses of any team" — luxury draft.
GM: Snead — aggressive, may trade pick 29 for a veteran rather than drafting.
CAPITAL: Pick 29 + later rounds. Limited but roster is already strong.`,

  SF: `NEEDS: LT > WR. Trent Williams successor is top priority. 30 WR pre-draft visits (YAC-heavy scheme).
GM: Lynch. HC: Shanahan ("king coach") — scheme demands specific player profiles.
CAPITAL: Standard. LT R1 if possible. WR Day 2 — prioritize YAC profiles.`,

  SEA: `NEEDS: RG > RB. Kenneth Walker departed — need new lead back.
GM: Schneider — high-volume trader (74 pick trades across 16 drafts). Expect 3-5 trades on draft day.
CAPITAL: Standard, but Schneider will restructure it on draft day. Final order will look nothing like the original.`,
};

/**
 * General draft knowledge block.
 * Inject after the team-specific intel section.
 */
export const DRAFT_KNOWLEDGE_BLOCK = `## Draft Value & Trade Intelligence

**Jimmy Johnson Trade Value Chart (key picks)**:
Pick 1=3000, 2=2600, 3=2200, 4=1800, 5=1700, 6=1600, 7=1500, 8=1400, 9=1350, 10=1300, 11=1250, 12=1200, 13=1150, 14=1100, 15=1050, 16=1000, 17=950, 18=900, 19=875, 20=850, 21=800, 22=780, 23=760, 24=740, 25=720, 26=700, 27=680, 28=660, 29=640, 30=620, 31=604, 32=590, 33=580, 34=560, 35=550, 36=540, 40=480, 45=420, 50=370, 55=330, 60=300, 64=270, 70=230, 80=180, 90=140, 100=96

Both sides should exchange roughly equal total value. Flag lopsided deals.

**Trade-up success rates** (Barnwell analysis, 242 deals, 2011-2019):
- Trade-ups succeed only 42% of the time.
- 23% of trade-up picks become total busts (zero value).
- Teams trading DOWN won 85 of 140 non-QB first-three-round matchups — trading down is statistically superior.
- Surplus value peaks in the late 1st / early 2nd (picks 20-40) — sweet spot for value.
- QB and EDGE trade-ups succeed at higher rates than other positions — the only justifiable trade-up targets.
- WR trade-ups: 8 in five years, zero Pro Bowlers — 0% Pro Bowl rate.

**2026 Draft Intel — Prospect Buzz**:
- No. 1: Mendoza (QB, Indiana) to Raiders — universal consensus.
- No. 2: Bailey (EDGE, Texas Tech) vs Reese (LB/EDGE, Ohio State) — 50/50 for Jets.
- No. 3: RT or Ohio State LB to Cardinals — insider intel says NOT a QB.
- No. 10: Delane (CB, LSU) to Bengals — "most certain" non-No. 1 pick. Near-locked.
- Underrated: Cooper Jr. (WR, Indiana) — "tough as nails," rising stock. Value pick late 1st / early 2nd.
- Underrated: Max Iheanachor (OT, ASU) — "long-term left tackle." Day 2 OT sleeper.
- Falling: Jordyn Tyson (WR, ASU) — may tumble outside top 20 (hamstring, drops). Potential value if he falls.
- Falling: Rueben Bain Jr. (EDGE, Miami) — may fall outside top 12 despite elite talent. Trade-up target for EDGE-needy teams.

**Projected Trade Scenarios**:
- Washington (pick 7) may trade out of top 10 — only 3 picks in top 150 makes accumulation attractive.
- Pittsburgh has 5 top-100 picks — most aggressive trade-up candidate. Warn teams near PIT's targets.
- Rams may trade pick 29 for veteran talent — Snead prefers proven commodities.
- Eagles' Roseman: if an EDGE falls, expect Philadelphia to pounce. Warn teams picking ahead of PHI.
- Houston's Caserio will make multiple trades on draft day (25 trades since 2021).
- Seattle's Schneider averages 4-5 trades per draft (74 across 16 drafts) — picks will shift constantly.`;
