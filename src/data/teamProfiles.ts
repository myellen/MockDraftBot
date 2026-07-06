// Dataset selector shim — do NOT put strategy prompts in this file.
// College-draft strategies live in teamProfiles.college.ts,
// redraft strategies in teamProfiles.redraft.ts.
import { DRAFT_MODE } from './draftMode';
import { DEFAULT_STRATEGY_PROMPTS as COLLEGE_PROMPTS } from './teamProfiles.college';
import { REDRAFT_STRATEGY_PROMPTS } from './teamProfiles.redraft';

export const DEFAULT_STRATEGY_PROMPTS: Record<string, string> =
  DRAFT_MODE === 'redraft' ? REDRAFT_STRATEGY_PROMPTS : COLLEGE_PROMPTS;
