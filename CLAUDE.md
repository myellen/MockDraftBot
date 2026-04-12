# MockDraftBot

Discord bot for running full 7-round NFL mock drafts. Built with discord.js v14 + TypeScript.

## Build & Run

The bot runs in Docker. Never manage node processes directly.

```bash
# Ensure Docker is on PATH (Windows)
export PATH="$PATH:/c/Program Files/Docker/Docker/resources/bin"

# Rebuild and restart
docker compose down && docker compose up --build -d

# Verify it started
docker logs mockdraftbot-draft-bot-1 | tail -3
# Should show: "✅ Logged in as NFL Mock Draft 2026#6631"
```

## Type Checking

```bash
# Use this — NOT `npx tsc` (npx resolves the wrong package)
./node_modules/.bin/tsc --noEmit
```

## Architecture

### Core Classes

- **`src/draft/DraftManager.ts`** — Main orchestrator. Manages draft state, picks, schedule, boards, persistence. One instance per guild.
- **`src/draft/TradeManager.ts`** — Extracted from DraftManager. Handles trade proposals, acceptance, salary cap validation, trade history. Accessed via `manager.trades.*`.
- **`src/draft/types.ts`** — All shared types (`DraftState`, `PendingTrade`, `FuturePickRight`, `PlayerSalary`, etc.)

### Commands (`src/commands/`)

Each file exports `data` (SlashCommandBuilder) and `execute(interaction, manager)`.

| Command | File | Description |
|---------|------|-------------|
| `/draft` | `draft.ts` | Admin setup, start/pause/resume/reset, team assignments |
| `/pick` | `pick.ts` | Make a draft pick |
| `/autopick` | `autopick.ts` | Auto-pick using strategy/board/BPA |
| `/board` | `board.ts` | View prospects, submit custom board |
| `/board-ai` | `board-ai.ts` | AI scouting assistant — boards, strategy prompts, RAG trait search |
| `/trade` | `trade.ts` | Propose/accept/decline trades (picks, players, future picks) |
| `/trade-ai` | `trade-ai.ts` | AI-assisted trade proposals via Ollama |
| `/trade-history` | `trade-history.ts` | View completed trades + leaderboards |
| `/inventory` | `inventory.ts` | Team's picks, roster, cap info |
| `/status` | `status.ts` | Current draft status |
| `/upcoming` | `upcoming.ts` | Preview next picks |
| `/roster` | `roster.ts` | Team's draft selections |
| `/recap` | `recap.ts` | Link to recap spreadsheet |
| `/help` | `help.ts` | Full usage guide |

### AI / LLM (`src/llm/`)

- **`OllamaService.ts`** — Two Ollama clients: cloud client for chat (`OLLAMA_HOST`) and local client for embeddings (`OLLAMA_EMBED_HOST`). Exports `chatJSON()`, `chatStream()`, `embed()`.
- **`EmbeddingService.ts`** — In-memory vector index for scouting writeups. Embeds ~397 prospects at startup using `nomic-embed-text` on local GPU. Cosine similarity search with optional position filtering.
- **`SmartAutopick.ts`** — LLM-powered autopick. Takes strategy prompt + custom board + roster context, returns a pick. 5s timeout via `Promise.race`, falls back to board/BPA on failure.

### Data (`src/data/`)

- `prospects.ts` — Ranked prospect list (500+). Has `.example.ts` template.
- `draftOrder.ts` — Pick order + pre-draft future pick trades. Has `.example.ts` template.
- `rosters.ts` — Current NFL rosters (generated from ESPN). Has `.example.ts` template.
- `salaries.ts` — Player salary/cap data (generated from Spotrac). Has `.example.ts` template. `SALARY_CAP` constant lives here.
- `teams.ts` — Team metadata (name, abbreviation, colors, etc.)
- `beastScouting.ts` — Beast scouting data (2550 prospects). In-memory structured query engine with filter/sort/limit. Also wraps RAG search from EmbeddingService.
- `teamProfiles.ts` — Default strategy prompts for all 32 NFL teams (used when user hasn't set a custom strategy).

### Scripts (`scripts/`)

- `generate-rosters.ts` — Scrapes ESPN for current rosters
- `generate-salaries.ts` — Scrapes Spotrac for salary data

**Note:** Don't run `generate-salaries.ts` casually — it overwrites manual fixes to salary data. Manual edits to `salaries.ts` are preferred for targeted corrections.

### Persistence

Draft state is saved as JSON in `data/draft-state-{guildId}.json`. The Docker volume mounts `./data:/app/data` so state survives container rebuilds.

## Key Patterns

- **Future pick format:** `2027R1` or `2027R5-CAR` (the `-TEAM` suffix disambiguates when a team holds multiple picks in the same round). `DraftManager.resolveFuturePickRight()` defaults to the team's own pick when no suffix is given.
- **Trade method access:** Commands call `manager.trades.proposeTrade(...)`, `manager.trades.acceptTrade(...)`, etc. Cap methods are also on TradeManager: `manager.trades.getTeamCapInfo(...)`.
- **Two-phase LLM in board-ai:** User prompt → fast extraction call (parses intent into `DataNeeds` JSON) → parallel data fetching (RAG + structured query + lookups) → main LLM call with all data pre-injected. The main LLM cannot call tools mid-response. See `docs/rag-query-architecture.md` for full details.
- **RAG + structured query coexistence:** Qualitative traits ("high motor") go through RAG embedding search. Quantitative filters (40 time, height) go through the structured query engine. Position filters propagate from structured query to RAG. Results are injected as separate sections; the LLM cross-references them naturally.
- **Strategy prompts replace position priority:** Users set natural language strategy prompts via board-ai conversation (e.g., "Prioritize EDGE and CB, value athletic upside"). Stored in `BoardData.strategyPrompts`. Used by smart autopick to make intelligent draft picks.
- **Autopick fallback chain:** (1) Smart LLM pick using strategy + board context (5s timeout) → (2) first available from custom board → (3) BPA.
- **Docker two-service setup:** `draft-bot` (Node.js) uses Ollama Cloud for chat and the local `ollama` container (GPU-accelerated) for embeddings. Ollama Cloud does not support embedding models, so embeddings must run locally.
- **Discord embed limit** is 6000 chars total per message. Long outputs (like trade history) split across `reply()` + `followUp()`.

## Environment Variables

```
DISCORD_TOKEN=       # Bot token
CLIENT_ID=           # Application client ID
GUILD_ID=            # Server guild ID (for command registration)
SUPER_ADMINS=        # Comma-separated user IDs with admin override
OLLAMA_HOST=         # Ollama Cloud endpoint for chat completions
OLLAMA_MODEL=        # Chat model name (e.g. gemma4:31b)
OLLAMA_API_KEY=      # API key for Ollama Cloud
OLLAMA_EMBED_HOST=   # Local Ollama endpoint for embeddings (e.g. http://ollama:11434)
OLLAMA_EMBED_MODEL=  # Embedding model name (e.g. nomic-embed-text)
LOG_PROMPTS=         # Set to "true" or "1" to log full board-ai prompts to logs/prompts/
```
