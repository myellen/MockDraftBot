# MockDraftBot

Discord bot + web app for running full 7-round NFL mock drafts with AI GMs. Built with discord.js v14, Express, React 19, and TypeScript.

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

The project has two interfaces (Discord bot + web SPA) sharing a common engine layer.

### Engine Layer (`src/engine/`)

Framework-agnostic draft simulation — no Discord or Express dependencies.

- **`DraftEngine.ts`** — Main orchestrator. Manages draft state, picks, timers, advance loop, event emission. One instance per room/guild.
- **`TradeEngine.ts`** — Trade validation and execution. Salary cap enforcement, pick ownership checks, future pick rights, superseded trade cancellation. Accessed via `engine.trades.*`.
- **`AIGMService.ts`** — AI GM deliberation system. Runs per-pick: heuristic scores all 32 GMs, top candidates get sequential LLM calls, trades execute or get sent to humans as CPU offers. Accessed via `engine.aiGM.*`.
- **`tradeValue.ts`** — Trade valuation with four value charts (standard, analytics, old_school, aggressive). `isTradeReasonable()` guardrail.
- **`events.ts`** — Typed event map: `pick:made`, `draft:started/paused/resumed/complete/reset`, `trade:executed/cancelled/chatter`, `cpu-offer:sent/resolved`, `insider:tweet`, `pick:clock`.
- **`types.ts`** — Core types (`DraftState`, `PendingTrade`, `FuturePickRight`, `CompletedPick`, `TradeLogEntry`, etc.)
- **`interfaces.ts`** — `PersistenceProvider` and `TimerProvider` abstractions.
- **`scheduleBuilder.ts`** — Converts draft order into `PickSlot[]` schedule.

### Discord Bot (`src/commands/`, `src/discord/`)

- **`src/discord/DraftManager.ts`** — Discord adapter. Wraps engine with Discord-specific persistence, timers (setTimeout), and embed formatting.
- **`src/commands/`** — Each file exports `data` (SlashCommandBuilder) and `execute(interaction, manager)`.

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
| `/leak` | `leak.ts` | Leak intel to InsiderX — generates insider tweet, influences AI GMs |
| `/rumor` | `rumor.ts` | Full leaker→reporter pipeline for social feed |
| `/status` | `status.ts` | Current draft status |
| `/upcoming` | `upcoming.ts` | Preview next picks |
| `/roster` | `roster.ts` | Team's draft selections |
| `/recap` | `recap.ts` | Link to recap spreadsheet |
| `/help` | `help.ts` | Full usage guide |

### Web Server (`src/web/`)

Express 5 + WebSocket server. Serves the React SPA and provides REST/WS APIs.

- **`WebServer.ts`** — Express entry point. Mounts routes, static file serving with cache-busting headers, WebSocket upgrade handling.
- **`WebAdapter.ts`** — Adapts DraftEngine for web. Handles persistence (atomic file writes with unique temp filenames), timer callbacks, WebSocket broadcasts, feed item persistence.
- **`RoomManager.ts`** — Multi-room support. Creates rooms, issues HMAC tokens (base64url-encoded payloads), routes messages to specific rooms.
- **`auth.ts`** — Token generation and verification middleware.
- **`routes/rooms.ts`** — Create/join rooms.
- **`routes/state.ts`** — GET state, prospects (paginated), teams.
- **`routes/draft.ts`** — Register team, start/pause/resume/reset, make picks, leak intel, get insiders.
- **`routes/trade.ts`** — Propose/accept/decline trades, CPU offer accept/decline.
- **`routes/board.ts`** — Custom board CRUD, strategy, reorder, add/remove.
- **`routes/ai.ts`** — Trade AI chat, Board AI chat, clear AI history.

### React SPA (`web/`)

React 19 + Vite 6. Bundled to `web/dist/` and served by Express.

- **`web/src/api.ts`** — HTTP client with token management.
- **`web/src/ws.ts`** — WebSocket client with event subscription.
- **`web/src/types.ts`** — Frontend type mirrors.

Key components:
- **`DraftRoom.tsx`** — Main container. Manages state, WebSocket events, feed items, CPU offers.
- **`CommandCenter.tsx`** — Tabbed panel: On Clock, Trades, Trade AI, Board, Scout AI, Roster, Leak, Settings, My Team. Uses `display: none` to preserve tab state.
- **`DraftBoard.tsx`** / **`PickCell.tsx`** — Visual draft board grid with ESPN team logos.
- **`TradeCenter.tsx`** — Trade proposals + incoming CPU offer cards with accept/decline.
- **`SocialFeed.tsx`** / **`TweetCard.tsx`** — InsiderX social feed (insider tweets, trade chatter, pick announcements).
- **`BoardAIChat.tsx`** / **`TradeAIChat.tsx`** — Multi-turn LLM chat UIs.
- **`LeakPanel.tsx`** — Submit leak intel with insider persona picker.
- **`OnTheClock.tsx`** — Current pick info, prospect list, pick/autopick buttons.

### AI / LLM (`src/llm/`)

- **`OllamaService.ts`** — Two Ollama clients: cloud for chat (`OLLAMA_HOST`), local for embeddings (`OLLAMA_EMBED_HOST`). Exports `chatJSON()`, `chatText()`, `chatJSONWithHistory()`, `embed()`.
- **`TradeAI.ts`** — LLM trade functions: `generateTradeIdea()`, `evaluateIncomingTrade()`, `decideOnClockTrade()`. 8s timeout guardrails. Supports player trades and leak context injection.
- **`InsiderService.ts`** — Two-stage leaker→reporter pipeline for insider tweets.
- **`insiderData.ts`** — Insider personas (Schefter, Rapoport, Fowler, etc.) with styles and avatars.
- **`SmartAutopick.ts`** — LLM-powered autopick using strategy + board + roster context. 5s timeout, falls back to board/BPA on failure.
- **`EmbeddingService.ts`** — In-memory vector index for scouting writeups. Cosine similarity search with optional position filtering.

### Data (`src/data/`)

The dataset layer is mode-switched (see **Draft Modes** below). `prospects.ts`, `rosters.ts`, `draftOrder.ts`, `gmBoards.ts`, and `teamProfiles.ts` are checked-in **selector shims** that re-export the active dataset based on `DRAFT_MODE`; the real data lives in `.college.ts` / `.redraft.ts` siblings.

- `draftMode.ts` — Exports `DRAFT_MODE` (`'college' | 'redraft'`) from the env var. Fixed at process start.
- `prospects.ts` → `prospects.college.ts` (gitignored, hand-sourced big board) or `prospects.redraft.ts` (gitignored, generated by `npm run gen-redraft`). Both have `.example.ts` templates. Shim computes `PROSPECTS_DEDUPED`, `PROSPECT_BY_RANK`, `ALL_POSITIONS`.
- `draftOrder.ts` → `draftOrder.college.ts` (gitignored). Redraft reuses the same slots as a clean slate: `currentTeam = originalTeam`, no future-pick trades.
- `rosters.ts` → `rosters.college.ts` (gitignored, generated from ESPN). Redraft exports `{}` — every player is in the pool, so teams have no pre-existing roster.
- `gmBoards.ts` → `gmBoards.college.ts` or `gmBoards.redraft.ts` (empty for now — board ranks index into the ACTIVE pool, so college boards are silently wrong under a redraft pool).
- `teamProfiles.ts` → `teamProfiles.college.ts` or `teamProfiles.redraft.ts` (generic rebuild-from-scratch strategy for all 32 teams).
- `salaries.ts` — Player salary/cap data (generated from Spotrac). Has `.example.ts` template. `SALARY_CAP` constant lives here. Shared by both modes.
- `capData.ts` — Per-team cap data + player trade values (cap hit, dead money, incoming cap). Shared by both modes.
- `teams.ts` — Team metadata (name, city, abbreviation, colors).
- `gmProfiles.ts` — AI GM personalities for all 32 teams. 8 archetypes (Closer, Architect, Gunslinger, Dealmaker, Fortress, Opportunist, Builder, Veteran) with trade aggression, risk tolerance, value chart preference, position values. In redraft mode, `TradeAI.personalityForMode()` strips the college-specific `TARGETS:`/`CAPITAL:` lines at prompt time.
- `beastScouting.ts` — Beast scouting data (2550 college prospects). Structured query engine with filter/sort/limit. Also wraps RAG search from EmbeddingService. In redraft mode it loads `data/redraft-scouting-compact.json` instead — the file doesn't exist, which cleanly disables scouting/RAG everywhere (and prevents fuzzy name matches attaching college reports to same-named NFL veterans).
- `boardSystemPrompt.ts` — Board-AI intel blocks. `TEAM_DRAFT_INTEL` is empty and the 2026 prospect-buzz block is replaced by a redraft note in redraft mode.

### Draft Modes

`DRAFT_MODE=college` (default) or `DRAFT_MODE=redraft` — set in `.env`, applied at container start.

**Redraft mode** re-drafts current NFL players: the pool is generated from live ESPN rosters (`npm run gen-redraft`), each player's `school` is his current NFL team (e.g. `Josh Allen — Buffalo Bills`), and rank order = consensus redraft value (curated top ~220 + position/cap/age heuristic tail, ~600 players). Redraft defaults flip `allowPlayerTrades` and `enforceSalaryCap` to `false` (the pool and the rosters are the same humans; contracts don't transfer).

Switching modes:
1. Edit `DRAFT_MODE` in `.env`, then `docker compose down && docker compose up --build -d`.
2. Persisted states/boards are stamped with their dataset; a stamp mismatch at load logs a warning and starts fresh (rank IDs are dataset-relative, so cross-mode loads would corrupt silently). College saves are untouched on disk and load again when you switch back.

For next year's real draft: regenerate `prospects.college.ts` / `draftOrder.college.ts` (new class + order), rerun `npm run gen-rosters`, and college mode works unchanged. For a fresh redraft pool, rerun `npm run gen-redraft` and update the `CURATED_TOP` list in `scripts/generate-redraft-dataset.ts`.

### Scripts (`scripts/`)

- `generate-rosters.ts` — Scrapes ESPN for current rosters (writes `rosters.college.ts`)
- `generate-salaries.ts` — Scrapes Spotrac for salary data
- `generate-redraft-dataset.ts` — Builds the redraft player pool from live ESPN rosters + capData contract values + a curated top board (writes `prospects.redraft.ts`). Run via `npm run gen-redraft`.

**Note:** Don't run `generate-salaries.ts` casually — it overwrites manual fixes to salary data. Manual edits to `salaries.ts` are preferred for targeted corrections.

### Persistence

- **Discord:** `data/draft-state-{guildId}.json` (redraft mode: `data/redraft-state-{guildId}.json`). Docker volume mounts `./data:/app/data`.
- **Web:** `data/web-draft-state-{roomCode}.json` and `data/web-draft-boards-{roomCode}.json` (redraft mode: `web-redraft-*`). Atomic writes with unique temp filenames to prevent race conditions. Feed items (`feedItems`) stored in draft state and survive container restarts.
- Each mode has its own file namespace AND a dataset stamp inside the JSON, so flipping `DRAFT_MODE` can never clobber the other mode's saves — both coexist and resume when you switch back.

## Key Patterns

- **Future pick ID format:** `2027-R1-PHI` (year-round-originalTeam). LLM may return bare years (`2027`) or partial (`2027-R1`); `AIGMService.resolveFuturePicks()` resolves against actual rights.
- **Trade method access:** `engine.trades.proposeTrade(...)`, `engine.trades.executeCPUTrade(...)`, `engine.trades.getTeamCapInfo(...)`.
- **AI GM deliberation:** Per pick, heuristic scores all 32 GMs (no LLM, <1ms), top 3-4 get sequential LLM calls (Ollama Cloud Free = 1 concurrent). CPU picks target ~30s deliberation window. Human turns run deliberation in background via AbortController.
- **Trade validation chain:** `validateTradeIdea()` (both sides have assets + pick ownership) → `isTradeReasonable()` (value ratio check) → `executeCPUTrade()` (re-validates ownership at execution). Blocks trades where teams don't own referenced picks.
- **CPU offers to humans:** AI GM sends offers via `cpu-offer:sent` event → frontend shows in Trades tab with accept/decline. Invalidated when referenced picks are made (`invalidateOffersForPick`) or trades execute (`invalidateSupersededOffers`).
- **Leak → AI GM influence:** Leak tweets add to `AIGMService.recentLeaks`. Mentioned teams get a heuristic boost (+15 pts). Leak text injected into LLM trade prompts so GMs factor intel into decisions.
- **Two-phase LLM in board-ai:** User prompt → fast extraction call (parses intent into `DataNeeds` JSON) → parallel data fetching (RAG + structured query + lookups) → main LLM call with all data pre-injected.
- **Autopick fallback chain:** (1) Smart LLM pick using strategy + board context (5s timeout) → (2) first available from custom board → (3) BPA.
- **Docker three-service setup:** `draft-bot` (Node.js), `ollama` (local GPU for embeddings), `cloudflared` (tunnel). Ollama Cloud for chat, local Ollama for embeddings.
- **Discord embed limit** is 6000 chars total per message. Long outputs split across `reply()` + `followUp()`.
- **Reset clears everything:** `DraftEngine.reset()` clears draft state + trades + feed items, re-seeds `futurePickRights` from the dataset, and clears `playerOwnership`. `AIGMService.reset()` clears CPU offers, leaks, trade logs, cooldowns. Frontend clears feed + CPU offers.
- **ESPN team logos:** `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png` — used in draft board, on-clock, recent/upcoming picks.
- **Cache busting:** HTML served with `Cache-Control: no-cache`, hashed assets with `immutable`.

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
DRAFT_MODE=          # college (default) | redraft — selects the dataset (see Draft Modes)
WEB_PORT=            # Web server port (default 3100)
```
