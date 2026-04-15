import { Ollama } from 'ollama';
import Anthropic from '@anthropic-ai/sdk';

export interface OllamaConfig {
  host: string;       // e.g. "http://localhost:11434" or "https://ollama.com"
  apiKey?: string;     // required for Ollama Cloud
  model: string;       // e.g. "llama3.1", "deepseek-v3.1:671b-cloud"
  numCtx: number;      // context window size (default 32768)
}

/**
 * A prompt value that can be either a pre-built string or a factory function.
 * Factory functions are called just before sending to Ollama (after acquiring
 * the concurrency slot), so the prompt reflects current state rather than
 * state at enqueue time. Backwards-compatible: plain strings still work.
 */
export type PromptSource = string | (() => string);

export type LLMPriority = 'high' | 'low';

export interface ChatOptions {
  temperature?: number;
  signal?: AbortSignal;
  priority?: LLMPriority;
}

export class LLMAbortError extends Error {
  constructor(label: string) {
    super(`LLM call aborted: ${label}`);
    this.name = 'LLMAbortError';
  }
}

function resolvePrompt(v: PromptSource): string {
  return typeof v === 'function' ? v() : v;
}

let instance: Ollama | null = null;
let currentConfig: OllamaConfig | null = null;

function getConfig(): OllamaConfig {
  if (currentConfig) return currentConfig;
  currentConfig = {
    host: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    apiKey: process.env.OLLAMA_API_KEY,
    model: process.env.OLLAMA_MODEL ?? 'llama3.1',
    numCtx: parseInt(process.env.OLLAMA_CTX ?? '32768', 10),
  };
  return currentConfig;
}

function getClient(): Ollama {
  if (instance) return instance;
  const config = getConfig();
  const headers: Record<string, string> = {};
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }
  instance = new Ollama({ host: config.host, headers });
  return instance;
}

export function isAnthropicConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export function isOllamaConfigured(): boolean {
  return !!process.env.OLLAMA_HOST || !!process.env.OLLAMA_MODEL || isAnthropicConfigured();
}

// ── Anthropic client ──────────────────────────────────────────────────────

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (anthropicClient) return anthropicClient;
  anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

function getAnthropicModel(): string {
  return process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';
}

async function anthropicChat(
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  temperature: number,
  signal?: AbortSignal,
): Promise<string> {
  const client = getAnthropicClient();
  const response = await client.messages.create(
    {
      model: getAnthropicModel(),
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      temperature,
    },
    signal ? { signal } : undefined,
  );
  const block = response.content[0];
  return block.type === 'text' ? block.text.trim() : '';
}

function parseJSON<T>(text: string): T {
  let cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as T;
      } catch { /* fall through */ }
    }
    throw new Error(`Invalid JSON from LLM: ${cleaned.slice(0, 500)}`);
  }
}

// ── Concurrency limiter (Ollama Cloud Free = 1 concurrent request) ──────

const MAX_CONCURRENT = parseInt(process.env.OLLAMA_MAX_CONCURRENT ?? '1', 10);
const STALE_THRESHOLD_MS = 10_000; // warn when queue wait exceeds this
let activeRequests = 0;
let requestCounter = 0;
const highQueue: Array<() => void> = [];
const lowQueue: Array<() => void> = [];

function acquire(priority: LLMPriority = 'high'): Promise<void> {
  if (activeRequests < MAX_CONCURRENT) {
    activeRequests++;
    return Promise.resolve();
  }
  const queue = priority === 'high' ? highQueue : lowQueue;
  return new Promise<void>(resolve => queue.push(resolve));
}

function release(): void {
  const next = highQueue.shift() ?? lowQueue.shift();
  if (next) {
    next(); // hand the slot to the next waiter (high priority first)
  } else {
    activeRequests--;
  }
}

async function withSlot<T>(label: string, signal: AbortSignal | undefined, fn: () => Promise<T>, priority: LLMPriority = 'high'): Promise<T> {
  const id = ++requestCounter;
  const enqueueTime = Date.now();
  const depth = highQueue.length + lowQueue.length;
  const tag = priority === 'low' ? ' [low]' : '';
  console.log(`[LLM] #${id} QUEUED ${label}${tag} (depth: ${depth})`);

  await acquire(priority);

  // Check abort before executing — skip the model call if caller already timed out
  if (signal?.aborted) {
    const waitMs = Date.now() - enqueueTime;
    console.log(`[LLM] #${id} ABORTED ${label} (wait: ${(waitMs / 1000).toFixed(1)}s — skipped)`);
    release();
    throw new LLMAbortError(label);
  }

  const waitMs = Date.now() - enqueueTime;
  const staleTag = waitMs >= STALE_THRESHOLD_MS ? ' ⚠ STALE' : '';
  console.log(`[LLM] #${id} SENDING ${label} (wait: ${(waitMs / 1000).toFixed(1)}s${staleTag})`);

  const sendTime = Date.now();
  try {
    const result = await fn();
    const callMs = Date.now() - sendTime;
    const totalMs = Date.now() - enqueueTime;
    console.log(`[LLM] #${id} DONE ${label} (call: ${(callMs / 1000).toFixed(1)}s, total: ${(totalMs / 1000).toFixed(1)}s)`);
    return result;
  } catch (err) {
    const callMs = Date.now() - sendTime;
    const totalMs = Date.now() - enqueueTime;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[LLM] #${id} ERROR ${label} (call: ${(callMs / 1000).toFixed(1)}s, total: ${(totalMs / 1000).toFixed(1)}s) ${msg}`);
    throw err;
  } finally {
    release();
  }
}

/** Current queue depth for monitoring. */
export function getQueueStats(): { active: number; queued: number; queuedLow: number } {
  return { active: activeRequests, queued: highQueue.length, queuedLow: lowQueue.length };
}

/**
 * Batch-embed one or more texts using the local embedding model.
 * Uses a separate local Ollama instance (OLLAMA_EMBED_HOST, default localhost:11434)
 * with the model specified by OLLAMA_EMBED_MODEL (default nomic-embed-text).
 */
let embedClient: Ollama | null = null;

function getEmbedClient(): Ollama {
  if (embedClient) return embedClient;
  const host = process.env.OLLAMA_EMBED_HOST || 'http://localhost:11434';
  embedClient = new Ollama({ host });
  return embedClient;
}

export async function embed(input: string | string[]): Promise<number[][]> {
  const client = getEmbedClient();
  const model = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
  const response = await client.embed({ model, input });
  return response.embeddings;
}

/**
 * Send a chat completion request and parse the response as JSON.
 * Uses format: 'json' to instruct Ollama to return valid JSON.
 *
 * System and user prompts accept PromptSource — pass a factory function
 * instead of a string to build the prompt just before sending (after
 * acquiring the concurrency slot), avoiding stale context from queue waits.
 */
export async function chatJSON<T>(
  systemPrompt: PromptSource,
  userMessage: PromptSource,
  options?: ChatOptions | number,
): Promise<T> {
  const { temperature = 0.3, signal, priority } = typeof options === 'number'
    ? { temperature: options, signal: undefined, priority: undefined }
    : (options ?? {});
  return withSlot('chatJSON', signal, async () => {
    const system = resolvePrompt(systemPrompt);
    const user = resolvePrompt(userMessage);

    if (isAnthropicConfigured()) {
      const text = await anthropicChat(system, [{ role: 'user', content: user }], temperature, signal);
      return parseJSON<T>(text);
    }

    const client = getClient();
    const config = getConfig();

    const response = await client.chat({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      format: 'json',
      options: {
        temperature,
        num_predict: 16384,
        num_ctx: config.numCtx,
      },
    });

    return parseJSON<T>(response.message.content);
  }, priority);
}

/**
 * Send a multi-turn chat completion request and parse the response as JSON.
 * Accepts conversation history as alternating user/assistant messages.
 */
export async function chatJSONWithHistory<T>(
  systemPrompt: PromptSource,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  userMessage: PromptSource,
  options?: ChatOptions,
): Promise<T> {
  const { temperature = 0.3, signal, priority } = options ?? {};
  return withSlot('chatJSONWithHistory', signal, async () => {
    const system = resolvePrompt(systemPrompt);
    const user = resolvePrompt(userMessage);
    const allMessages = [
      ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
      { role: 'user' as const, content: user },
    ];

    if (isAnthropicConfigured()) {
      const text = await anthropicChat(system, allMessages, temperature, signal);
      return parseJSON<T>(text);
    }

    const client = getClient();
    const config = getConfig();

    const response = await client.chat({
      model: config.model,
      messages: [
        { role: 'system' as const, content: system },
        ...allMessages,
      ],
      format: 'json',
      options: {
        temperature,
        num_predict: 16384,
        num_ctx: config.numCtx,
      },
    });

    return parseJSON<T>(response.message.content);
  }, priority);
}

/**
 * Send a chat completion request and return the raw text response.
 */
export async function chatText(
  systemPrompt: PromptSource,
  userMessage: PromptSource,
  options?: ChatOptions | number,
): Promise<string> {
  const { temperature = 0.3, signal, priority } = typeof options === 'number'
    ? { temperature: options, signal: undefined, priority: undefined }
    : (options ?? {});
  return withSlot('chatText', signal, async () => {
    const system = resolvePrompt(systemPrompt);
    const user = resolvePrompt(userMessage);

    if (isAnthropicConfigured()) {
      return anthropicChat(system, [{ role: 'user', content: user }], temperature, signal);
    }

    const client = getClient();
    const config = getConfig();

    const response = await client.chat({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      options: {
        temperature,
        num_predict: 16384,
        num_ctx: config.numCtx,
      },
    });

    return response.message.content.trim();
  }, priority);
}
