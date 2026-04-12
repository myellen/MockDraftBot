# RAG + Structured Query Architecture

## Problem

NFL scouting data has two fundamentally different kinds of information:

- **Quantitative**: measurable attributes like 40-yard dash time, height, weight, receiving touchdowns, bench press reps. These are numeric, filterable, and sortable.
- **Qualitative**: scouting language like "high motor", "violent hands", "fluid off the line", "nose for the football". These are embedded in free-text writeups and cannot be filtered with numeric operators.

Users naturally combine both in a single question: *"Which receivers are best at beating press coverage? Give me their combine numbers sorted by 40 time."* This requires two retrieval systems working together.

## Architecture Overview

```
User Prompt
    |
    v
[Extraction LLM] ---- fast, small call that parses intent
    |
    +---> ragQuery: "beating press coverage"     (qualitative)
    +---> query: { pos=WR, sort: forty asc }     (quantitative)
    +---> lookups, posLists, topN, board          (other data needs)
    |
    v
[Data Fetching Layer] ---- parallel retrieval from multiple sources
    |
    +---> RAG Search (cosine similarity on embeddings)
    |       |
    |       +---> Position-filtered to WR only (inherited from structured query)
    |       +---> Returns: names + relevance scores + text snippets
    |       +---> ALSO fetches full measurements/stats for each match
    |       |
    +---> Structured Query (in-memory filter/sort engine)
    |       |
    |       +---> Returns: all WRs with combine data, sorted by forty
    |       |
    +---> Named lookups, position lists, board data, top-N BPA
    |
    v
[All results injected into main LLM context]
    |
    v
[Main LLM] ---- has RAG matches WITH their measurements + structured results
    |
    v
Response: table of RAG-matched receivers with combine data, grade, stats,
          plus scouting highlights explaining WHY each matched
```

## Key Design Decisions

### 1. Two-Phase LLM Architecture

The system uses two LLM calls per user prompt:

**Phase 1 - Extraction** (fast, ~1s): A small LLM call that parses the user's natural language into a structured `DataNeeds` object. This determines WHAT data to fetch before the main call runs. The extraction prompt is compact and focused solely on intent classification.

**Phase 2 - Response** (slower, ~5-15s): The main LLM call receives the full system prompt (team context, board, roster) plus all pre-fetched scouting data. It synthesizes everything into a response.

This separation matters because the main LLM cannot call tools or fetch data mid-response. All data must be pre-injected into its context window.

### 2. The DataNeeds Interface

The extraction LLM returns a single JSON object that drives all data fetching:

```typescript
interface DataNeeds {
  lookups: string[];                    // "tell me about Cam Ward" -> ["Cam Ward"]
  posRanks: Array<{pos, rank}>;        // "EDGE 30" -> [{pos:"EDGE", rank:30}]
  posLists: Array<{pos, count}>;       // "top 10 EDGE" -> [{pos:"EDGE", count:10}]
  board: boolean;                      // "analyze my board" -> true
  topN: number;                        // "best available" -> 20
  query: ProspectQuery | null;         // SQL-like filter/sort/limit
  ragQuery: string | null;             // qualitative trait search string
}
```

Multiple fields can be populated simultaneously. A single user prompt like *"fast EDGEs with a high motor"* produces BOTH:
- `query: { filters: [{pos=EDGE}], sort: {combine.forty, asc} }` (the measurable part)
- `ragQuery: "high motor"` (the qualitative part)

### 3. Position Filter Propagation

When the structured query includes a position filter (e.g., `pos = WR`), that filter is automatically applied to the RAG search as well. This prevents a query like "receivers good at beating press" from returning cornerbacks who are good at *playing* press coverage.

```typescript
const posFilter = needs.query?.filters
  .find(f => f.field === 'pos' && f.op === 'eq')?.value as string | undefined;
const data = await ragSearch(needs.ragQuery, 15, posFilter);
```

The RAG search filters its candidate pool by position BEFORE computing cosine similarity, so all returned results are position-relevant.

### 4. RAG Result Enrichment

RAG search returns lightweight results: name, position, school, relevance score, and a 200-character text snippet. This is not enough for the main LLM to build a combine table.

After RAG results come back, the system automatically fetches full measurement profiles for each matched prospect. These are formatted as clearly labeled text (not raw JSON) so the LLM can reliably extract specific fields:

```
**Zachariah Branch** | WR3 | Georgia | Grade: 3rd round | OVR: ---
  Ht: 5'9", Wt: 177 | 40: 4.42, Vert: 36.5, Broad: 11'03", ...
  Latest stats (2024): receptions=47, receiving_yards=503, receiving_td=1
```

This enrichment step is what allows the main LLM to produce a complete table with combine data for qualitative trait matches.

### 5. Coexistence Without Intersection Logic

The RAG results and structured query results are injected as separate labeled sections in the LLM context. There is no code-level intersection or merging. The main LLM cross-references them naturally:

- It sees "these 8 WRs matched the trait 'beating press coverage'" (from RAG)
- It sees "here are all WRs sorted by forty time" (from structured query)
- It sees full measurement profiles for the RAG matches (from enrichment)
- It synthesizes: "here are the press-beating receivers with their combine numbers, sorted by 40 time"

This is intentional. Hard-coded intersection logic would be brittle and lose information. The LLM is better at judging how to combine results than any fixed algorithm.

## Component Details

### Embedding Index (`src/llm/EmbeddingService.ts`)

- Built once at startup, stored in memory
- Embeds ~397 prospects that have scouting writeup text (strengths, weaknesses, summary)
- Text blob per prospect: `"{name} | {pos} | {school}\nStrengths: ...\nWeaknesses: ...\n{summary}"`
- Uses `nomic-embed-text` model running in a local Ollama Docker container (GPU-accelerated)
- Cosine similarity search with optional position filtering
- Build time: ~13s on GPU, ~137s on CPU

### Structured Query Engine (`src/data/beastScouting.ts`)

- In-memory filter/sort engine operating on the full prospect dataset (2550 prospects)
- Supports dot-notation field paths: `combine.forty`, `stats.receiving_td`, `proDayDelta.wt`
- Automatic measurement parsing: height strings to inches, fractional measurements, broad jump format
- Filter operators: `eq`, `neq`, `lt`, `gt`, `lte`, `gte`, `in`, `contains`
- Sort with nulls-last semantics
- No external database required

### Extraction Prompt (`src/commands/board-ai.ts`)

The extraction prompt teaches the LLM to classify user intent:

- Named player lookups vs. position group requests vs. filtered queries vs. trait searches
- When to use `ragQuery` (qualitative traits) vs. `query` (measurable filters) vs. both
- Follow-up resolution (pronouns, "same but...", "rank those by...")
- Position abbreviation normalization

### Infrastructure

```
docker-compose.yml
  |
  +-- draft-bot (Node.js)
  |     Uses Ollama Cloud for chat (gemma4:31b)
  |     Uses local Ollama for embeddings (nomic-embed-text)
  |
  +-- ollama (GPU-accelerated container)
        Serves nomic-embed-text for embedding requests
        Model persisted in Docker volume across restarts
```

Chat completions (extraction + main response) go to Ollama Cloud for access to large models. Embedding requests go to the local Ollama container for speed and because Ollama Cloud does not support embedding models. The two clients are configured independently via environment variables.
