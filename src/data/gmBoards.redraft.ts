/**
 * AI GM draft boards for redraft mode.
 *
 * Intentionally empty for now: with no board, DraftEngine.getEffectiveBoard
 * falls through to the smart LLM autopick and then BPA (redraft pool rank IS
 * the value ordering), which produces sane picks without any board data.
 *
 * To give GMs personality-driven redraft boards later, generate rank arrays
 * against prospects.redraft.ts (ranks here index into the ACTIVE pool).
 */
export const REDRAFT_GM_BOARDS: Record<string, number[]> = {};
