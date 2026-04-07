# NFL Salary Cap Trade Impact Formula — CBA-Derived Implementation Spec

> Source: NFL-NFLPA Collective Bargaining Agreement (March 5, 2020), primarily Article 13 Sections 5–6 and Article 7.
> Purpose: Enable a Discord mock draft bot to accurately calculate cap implications of player trades and draft pick trades.
> Target runtime: Node.js module consumed by an existing `capTracker.js`.

---

## 1. Core Concept: What Counts as "Team Salary"

Team Salary is the sum of all cap charges a club owes in a given League Year. It includes:

- Paragraph 5 base salary (the year earned)
- Prorated signing bonus (straight-line over contract term, max 5 years)
- Likely-to-be-earned (LTBE) incentives
- Roster bonuses, reporting bonuses, workout bonuses (when earned)
- Dead money from released/traded players
- Guaranteed salary acceleration

**The Salary Cap check**: `Team Salary <= Salary Cap` must be true at all times.

**Cap Space** = `Salary Cap - Team Salary`

---

## 2. Signing Bonus Proration

Reference: Article 13, Section 6(b)(i)

### Formula

```
annual_proration = total_signing_bonus / min(contract_years_remaining, 5)
```

The signing bonus is spread evenly over the life of the contract, capped at 5 years. Each year carries an equal charge.

### Key Rules

- Player-terminable option years do NOT count as contract years for proration.
- Extension bonuses prorate over remaining years of old contract + extension years.
- Rookie contracts: signing bonus prorates over max 4 years (not 5), per Article 7, Section 3(g). The 5th-year option year is excluded from rookie bonus proration.

---

## 3. Signing Bonus Acceleration on Trade/Release

Reference: Article 13, Section 6(b)(ii)

This is the most important rule for trade cap math. When a player is traded or released, unamortized (remaining) signing bonus accelerates onto the trading team's cap.

### Before June 1 (or anytime in Final League Year)

```
dead_cap_current_year = sum of all unamortized signing bonus remaining
```

All remaining proration hits the CURRENT League Year immediately.

### After June 1 (except Final League Year)

```
dead_cap_current_year = current_year_proration_only
dead_cap_next_year    = all remaining unamortized bonus for future years
```

The current year's scheduled proration stays. All future-year proration shifts to the NEXT League Year.

### June 1 Designation (Pre-June 1 release treated as post-June 1)

Each team may designate up to **2 contracts per year** as "post-June 1" releases even if the cut happens before June 1. These follow the post-June 1 acceleration rules above: current-year proration stays, future amounts push to next year.

### The Critical Trade Rule

```
// Article 13, Section 6(b)(ii)(3):
// When a player is traded, the NEW team does NOT inherit any signing bonus proration.
// The old team eats ALL remaining unamortized bonus as dead money.

new_team_cap_charge = player.base_salary + player.roster_bonuses + player.LTBE_incentives
old_team_dead_money = sum(all_unamortized_signing_bonus_proration)
```

**This is the single most important rule**: the acquiring team only picks up unpaid base salary and earned/likely bonuses. The trading team absorbs all remaining prorated bonus.

---

## 4. Player Trade Cap Impact Formula

### For the TRADING (sending) team

```javascript
function tradingTeamCapImpact(player, tradeDate) {
  // Step 1: Remove base salary and earned bonuses (cap relief)
  let capRelief = player.remainingBaseSalary
                + player.remainingRosterBonuses
                + player.remainingLTBEIncentives;

  // Step 2: Calculate dead money (unamortized bonus acceleration)
  let totalUnamortizedBonus = 0;
  for (let year = currentYear; year <= contractEndYear; year++) {
    totalUnamortizedBonus += player.signingBonusProration[year];
  }

  let deadMoneyCurrentYear, deadMoneyNextYear;

  if (tradeDate <= JUNE_1 || isFinalLeagueYear) {
    // All unamortized bonus hits current year
    deadMoneyCurrentYear = totalUnamortizedBonus;
    deadMoneyNextYear = 0;
  } else {
    // Current year proration stays, rest shifts to next year
    deadMoneyCurrentYear = player.signingBonusProration[currentYear];
    deadMoneyNextYear = totalUnamortizedBonus - deadMoneyCurrentYear;
  }

  // Step 3: Net cap impact
  // Positive = cap space gained, Negative = cap space lost
  let netCapImpact = capRelief - deadMoneyCurrentYear;
  // deadMoneyNextYear is a separate future-year charge

  return { capRelief, deadMoneyCurrentYear, deadMoneyNextYear, netCapImpact };
}
```

### For the ACQUIRING (receiving) team

```javascript
function acquiringTeamCapImpact(player) {
  // The new team ONLY absorbs remaining unpaid obligations
  let newCapCharge = player.remainingBaseSalary
                   + player.remainingRosterBonuses
                   + player.remainingLTBEIncentives;

  // NO signing bonus proration transfers.
  // The new team's cap hit is just the remaining salary obligations.

  return { newCapCharge };
}
```

### Mid-Season Trade Adjustment

Reference: Article 13, Section 6(g)

If a player is traded after the first regular season game, the acquiring team only counts the portion of salary it might actually pay that season (prorated for remaining weeks).

```javascript
function midSeasonAdjustment(annualSalary, weeksRemaining, totalWeeks) {
  return Math.round(annualSalary * (weeksRemaining / totalWeeks));
}
```

---

## 5. Draft Pick Trade Cap Impact Formula

Draft pick trades affect cap differently than player trades because picks carry no existing salary — only future rookie slot obligations.

### Core Mechanism

Each draft slot has a predetermined rookie contract value set by the CBA's rookie wage scale (Article 7). When picks are traded:

```javascript
function pickTradeCapImpact(team, picksSent, picksReceived) {
  let capDelta = 0;

  // Picks sent = you no longer owe that rookie slot
  for (const pick of picksSent) {
    const slot = getRookieSlotValue(pick.number);
    capDelta += slot.year1CapHit;  // Cap relief
  }

  // Picks received = you now owe that rookie slot
  for (const pick of picksReceived) {
    const slot = getRookieSlotValue(pick.number);
    capDelta -= slot.year1CapHit;  // New cap obligation
  }

  return capDelta;
}
```

### Rookie Slot Value Structure (Article 7)

Each pick maps to a fixed contract structure:

```
total_4yr_value     = CBA-determined by slot position
signing_bonus       = negotiated within slot constraints, typically ~65-70% of total for Rd1
year1_cap_hit       = (signing_bonus / proration_years) + year1_base_salary
proration_years     = min(contract_length, 4) for rookies (NOT 5)
```

**Rule of 51 offset**: Between the start of the League Year and Week 1, only the top 51 contracts count. Drafted rookies automatically count at the minimum salary until signed. So the NET cap impact of signing a rookie is:

```
net_rookie_cap_impact = rookie_year1_cap_hit - minimum_salary_already_reserved
```

Where `minimum_salary_already_reserved` = $885,000 for 2026.

### Rookie Allocation Trades (Article 7, Section 3(j))

When a draft slot is traded BEFORE the draft:
- The Year-One Formula Allotment transfers to the receiving club
- The receiving club must have enough Year-One Rookie Allocation room
- The sending club's allocation shrinks accordingly

For mock draft bot purposes, this means: **track which team owns which picks, and the cap obligation follows the pick, not the original team.**

---

## 6. Combined Trade (Players + Picks) Formula

Most real draft-day trades involve both players and picks. Apply both formulas:

```javascript
function fullTradeCapImpact(trade) {
  const results = {};

  for (const party of trade.parties) {
    let capDelta = 0;

    for (const asset of party.sends) {
      if (asset.type === 'player') {
        // Sending a player
        const impact = tradingTeamCapImpact(asset);
        capDelta += impact.netCapImpact;
      }
      if (asset.type === 'pick') {
        // Sending a pick = shed that rookie slot obligation
        const slot = getRookieSlotValue(asset.pickNumber);
        capDelta += (slot.year1CapHit - ROOKIE_MINIMUM);
      }
    }

    for (const asset of party.receives) {
      if (asset.type === 'player') {
        // Receiving a player
        const impact = acquiringTeamCapImpact(asset);
        capDelta -= impact.newCapCharge;
      }
      if (asset.type === 'pick') {
        // Receiving a pick = absorb that rookie slot obligation
        const slot = getRookieSlotValue(asset.pickNumber);
        capDelta -= (slot.year1CapHit - ROOKIE_MINIMUM);
      }
    }

    results[party.team] = {
      capDelta,
      projectedCapSpace: getCurrentCapSpace(party.team) + capDelta,
      isCompliant: (getCurrentCapSpace(party.team) + capDelta) >= 0
    };
  }

  return results;
}
```

---

## 7. Incentive Revaluation on Trade

Reference: Article 13, Section 6(c)(xii)

When a player is traded, all team-performance incentives must be revalued under the LTBE/NLTBE rules using the NEW team's prior-year performance. This can change what counts against the cap:

```javascript
function revalueIncentivesOnTrade(player, newTeam) {
  for (const incentive of player.incentives) {
    if (incentive.isTeamPerformance) {
      // Re-evaluate using new team's prior year stats
      incentive.isLTBE = didTeamMeetThreshold(newTeam, incentive.category, incentive.threshold);

      if (incentive.isLTBE) {
        // Adds to new team's cap charge
        newTeamCapCharge += incentive.amount;
      }
      // If NLTBE, does NOT count against cap until earned
    }
  }
}
```

### LTBE vs NLTBE Decision Rules

- **LTBE (counts against cap now)**: Player/team met the threshold last year
- **NLTBE (deferred)**: Player/team did NOT meet the threshold last year
- **First-year rookies**: ALL incentives are deemed LTBE
- **Player-controlled incentives** (reporting, workouts): Always LTBE
- **Per-game/per-play incentives**: LTBE to the extent of prior year's actual performance

---

## 8. Guaranteed Salary Rules on Trade

Reference: Article 13, Section 6(d)

When a player with guaranteed money is traded:

- **Fully guaranteed salary** (skill + injury + cap): Counts in the year earned, no acceleration needed — the acquiring team absorbs it as a normal cap charge.
- **Skill + injury guaranteed only** (no cap guarantee): If the salary extends past the Final League Year, it gets reallocated into remaining CBA years by the club's choice.
- **Dead money from guarantees on release**: If a player is released after trade and has remaining guaranteed salary, that salary is immediately included in Team Salary at present value.

For trade purposes:
```
// Guaranteed salary that transfers to the new team:
transferred_guaranteed = player.guaranteedBaseSalary[remainingYears]

// This is just a normal salary obligation — no special acceleration.
// The new team is on the hook for it like any other contract.
```

---

## 9. Void Years and Dead Money

Some modern contracts include "void years" — fake contract years added solely to spread signing bonus proration over more years. When void years trigger (or a player is traded/released):

```
dead_money = sum(proration_allocated_to_void_years)
```

This accelerates onto the team's cap per the standard rules in Section 3 above.

For mock draft bot purposes: void year dead money is already baked into the team's existing cap numbers from OTC/Spotrac. Only NEW trades during the mock draft need to be calculated dynamically.

---

## 10. Rule of 51 (Offseason Roster Counting)

Reference: Article 13, Section 6(a)(i)

Between the start of the League Year and Week 1 of the regular season, only the **top 51 highest-valued contracts** count fully against the cap. Players ranked 52+ only count their bonus prorations, not base salary.

**Impact on draft pick trades**: A drafted rookie initially counts at the minimum salary ($885,000 in 2026) under the top-51. When signed, their full cap number replaces this minimum charge.

```
effective_cap_impact_of_signing_rookie = full_year1_cap_hit - minimum_salary
```

OTC's "Effective Cap Space" metric already accounts for this by projecting the full rookie class. **Use Effective Cap Space, not raw Cap Space, as the guardrail check during the draft.**

---

## 11. Data Model for Implementation

### Player Contract Object

```javascript
const playerContract = {
  playerId: "string",
  name: "string",
  team: "string",          // current team abbreviation
  position: "string",

  // Annual salary breakdown
  baseSalary: {
    2026: 8_500_000,
    2027: 9_000_000,
    // ...
  },

  // Signing bonus
  signingBonusTotal: 20_000_000,
  signingBonusProration: {
    2024: 4_000_000,    // already charged (historical)
    2025: 4_000_000,    // already charged (historical)
    2026: 4_000_000,    // current year
    2027: 4_000_000,    // future
    2028: 4_000_000,    // future
  },

  // Roster/reporting bonuses
  rosterBonuses: { 2026: 1_000_000 },
  reportingBonuses: {},

  // Guarantees
  guaranteedSalary: {
    2026: { skill: true, injury: true, cap: true, amount: 8_500_000 },
    2027: { skill: true, injury: true, cap: false, amount: 9_000_000 },
  },

  // Incentives
  incentives: [
    {
      amount: 500_000,
      category: "sacks",
      threshold: 10,
      isTeamPerformance: false,
      isLTBE: true,     // based on prior year
    }
  ],

  contractEndYear: 2028,
};
```

### Trade Object

```javascript
const trade = {
  timestamp: Date.now(),
  parties: [
    {
      team: "BUF",
      sends: [
        { type: "pick", pickNumber: 26, round: 1 },
        { type: "player", playerId: "player_123" }
      ],
      receives: [
        { type: "pick", pickNumber: 12, round: 1 }
      ]
    },
    {
      team: "TB",
      sends: [
        { type: "pick", pickNumber: 12, round: 1 }
      ],
      receives: [
        { type: "pick", pickNumber: 26, round: 1 },
        { type: "player", playerId: "player_123" }
      ]
    }
  ]
};
```

### Cap Snapshot Object

```javascript
const teamCap = {
  team: "BUF",
  salaryCap: 301_200_000,
  teamSalary: 288_908_843,    // total charges
  capSpace: 12_291_157,       // salaryCap - teamSalary
  effectiveCapSpace: 8_622_771,  // after projecting 51-man + rookies
  deadMoney: 46_164_050,      // existing dead cap charges
  rookiePoolAllocation: 0,    // set after draft order finalized
};
```

---

## 12. Validation Guardrails

Implement these checks before allowing any trade:

```javascript
function validateTrade(trade) {
  const errors = [];
  const warnings = [];

  for (const party of trade.parties) {
    const impact = calculateFullTradeImpact(party);
    const projected = party.effectiveCapSpace + impact.capDelta;

    // HARD FAIL: Over the cap
    if (projected < 0) {
      errors.push(`${party.team} would be $${Math.abs(projected)} over the cap`);
    }

    // WARNING: Dangerously low (need room for 53-man roster)
    if (projected >= 0 && projected < 3_000_000) {
      warnings.push(`${party.team} would have only $${projected} — may not fill roster`);
    }

    // WARNING: Dead money exceeds 25% of cap (historically problematic)
    const projectedDeadMoney = party.deadMoney + (impact.deadMoneyAdded || 0);
    if (projectedDeadMoney > party.salaryCap * 0.25) {
      warnings.push(`${party.team} dead money would reach $${projectedDeadMoney} (${(projectedDeadMoney/party.salaryCap*100).toFixed(1)}% of cap)`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
```

---

## 13. Simplifications for Mock Draft Context

The full CBA is enormously complex. For a mock draft bot, these simplifications are appropriate:

1. **Ignore NLTBE incentives**: Treat all incentives as already factored into the team's existing OTC cap number. Only revalue on trade if you have the data.

2. **Ignore deferred salary**: Present-value discounting (using the CBA's "Discount Rate") is only relevant for multi-year deferrals. Mock draft trades are current-year events.

3. **Use OTC/Spotrac as baseline**: Don't recalculate team salary from scratch. Start with published cap space numbers and apply deltas.

4. **Ignore void years for new trades**: Void years are a contract structuring tool. Draft-day trades don't create void years.

5. **Treat all mid-draft trades as pre-June 1**: The draft is in late April, so all signing bonus acceleration follows the pre-June 1 rules (full acceleration in current year).

6. **Approximate rookie slots with interpolation**: The CBA defines a complex formula for slot values (Article 7, Section 1(g)). In practice, OTC publishes the computed values — use those directly via a lookup table.

7. **For player trades, pre-load contract data**: Only model players who are realistic trade candidates. You don't need all 1,700+ NFL contracts — just the ~50-100 names that might move on draft day.

---

## 14. Quick Reference: Key CBA Section Map

| Topic | CBA Reference | What It Governs |
|-------|--------------|-----------------|
| What counts as Team Salary | Art. 13, Sec. 5 | Complete list of cap charges |
| Signing bonus proration | Art. 13, Sec. 6(b)(i) | Straight-line, max 5 years |
| Bonus acceleration (trade/release) | Art. 13, Sec. 6(b)(ii) | Dead money rules |
| What counts as "signing bonus" | Art. 13, Sec. 6(b)(iii) | 15 categories of bonus-like payments |
| LTBE/NLTBE incentives | Art. 13, Sec. 6(c) | Which incentives count against cap |
| Incentive revaluation on trade | Art. 13, Sec. 6(c)(xii) | Team incentives re-evaluated for new team |
| Guaranteed salary treatment | Art. 13, Sec. 6(d) | When guarantees accelerate |
| Traded contracts | Art. 13, Sec. 6(f) | New team gets unpaid salary only |
| Mid-season contracts | Art. 13, Sec. 6(g) | Prorated for remaining season |
| Rookie contract structure | Art. 7, Sec. 3 | 4-year fixed, signing bonus prorated over 4 |
| Rookie slot values | Art. 7, Sec. 1(g) | Formula allotment by pick position |
| Fifth-year option | Art. 7, Sec. 7 | Tiered by Pro Bowl/playtime, fully guaranteed |
| Rookie cap treatment | Art. 7, Sec. 8 | Valued per Art. 13; year-1 incentives = LTBE |
| Rule of 51 | Art. 13, Sec. 6(a)(i) | Only top 51 salaries count in offseason |
| 30% annual increase rule | Art. 13, Sec. 7 | Max year-over-year salary increase |
| Carryover room | Art. 13, Sec. 6(b)(v) | Unused cap rolls to next year |
