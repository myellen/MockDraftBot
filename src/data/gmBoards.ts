// Dataset selector shim — do NOT put board data in this file.
// College boards live in gmBoards.college.ts (built by scripts/generate-gm-boards.ts).
// Board ranks are indices into the ACTIVE prospect pool, so college boards are
// meaningless (silently wrong, not broken) under a redraft pool — redraft gets
// its own boards or none at all.
import { DRAFT_MODE } from './draftMode';
import { GM_BOARDS as COLLEGE_GM_BOARDS } from './gmBoards.college';
import { REDRAFT_GM_BOARDS } from './gmBoards.redraft';

export const GM_BOARDS: Record<string, number[]> =
  DRAFT_MODE === 'redraft' ? REDRAFT_GM_BOARDS : COLLEGE_GM_BOARDS;
