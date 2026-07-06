/**
 * Default strategy prompts for redraft mode.
 *
 * In a redraft every current NFL player is in the pool and all 32 rosters
 * start empty, so college-class targets and current-roster needs don't apply.
 * These defaults give every GM the same sound rebuild framework; per-team
 * personality still comes from gmProfiles, and users can override any team's
 * strategy in-app (/board strategy or the web Settings/Board tab).
 */
import { TEAMS } from './teams';

const REDRAFT_CORE = `MODE: League-wide REDRAFT. Every current NFL player is in the pool and every roster starts EMPTY — you are rebuilding a complete team from scratch over 7 rounds.
PRINCIPLES:
- The pool is ranked by consensus redraft value: lower rank number = better player. Deviate only with a clear positional reason.
- Premium positions early: QB > EDGE/OT > CB/WR > DT > everything else. If you leave the early rounds without a franchise QB, you likely won't get one.
- Youth wins a redraft: prefer ascending players (roughly 23-28) over aging stars when value is close.
- Build a real roster: don't triple up on one position while ignoring whole units. By round 7 you want a plausible starting core on both sides of the ball.
- Trades: value charts still apply to picks. There are no veteran/player trades in this mode — picks and future picks only.`;

export const REDRAFT_STRATEGY_PROMPTS: Record<string, string> = Object.fromEntries(
  Object.values(TEAMS).map(t => [
    t.abbr,
    `TEAM: ${t.name}\n${REDRAFT_CORE}`,
  ])
);
