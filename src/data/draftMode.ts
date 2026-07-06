// Load .env before reading the mode — data modules are imported before
// src/index.ts runs, and standalone scripts import them directly.
import 'dotenv/config';

export type DraftMode = 'college' | 'redraft';

/**
 * Which dataset the process runs against. Fixed at startup:
 *   DRAFT_MODE=redraft  → re-draft current NFL players (school = their NFL team)
 *   anything else       → normal college draft (default)
 *
 * Switching modes requires a container restart. Persisted draft states are
 * stamped with the mode they were created under and refuse to load across
 * modes (rank IDs are dataset-relative).
 */
export const DRAFT_MODE: DraftMode =
  process.env.DRAFT_MODE === 'redraft' ? 'redraft' : 'college';
