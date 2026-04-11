import { Ollama } from 'ollama';

export interface OllamaConfig {
  host: string;       // e.g. "http://localhost:11434" or "https://ollama.com"
  apiKey?: string;     // required for Ollama Cloud
  model: string;       // e.g. "llama3.1", "deepseek-v3.1:671b-cloud"
  numCtx: number;      // context window size (default 32768)
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

export function isOllamaConfigured(): boolean {
  return !!process.env.OLLAMA_HOST || !!process.env.OLLAMA_MODEL;
}

/**
 * Send a chat completion request and parse the response as JSON.
 * Uses format: 'json' to instruct Ollama to return valid JSON.
 */
export async function chatJSON<T>(systemPrompt: string, userMessage: string): Promise<T> {
  const client = getClient();
  const config = getConfig();

  const response = await client.chat({
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    format: 'json',
    options: {
      temperature: 0.3,
      num_predict: 16384,
      num_ctx: config.numCtx,
    },
  });

  let text = response.message.content.trim();
  console.log('[OllamaService] chatJSON raw response:', text);
  // Strip wrapping code fences — only the outer ones, not code blocks inside JSON string values
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '').trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as T;
      } catch { /* fall through */ }
    }
    throw new Error(`Invalid JSON from LLM: ${text.slice(0, 500)}`);
  }
}

/**
 * Send a multi-turn chat completion request and parse the response as JSON.
 * Accepts conversation history as alternating user/assistant messages.
 */
export async function chatJSONWithHistory<T>(
  systemPrompt: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  userMessage: string,
): Promise<T> {
  const client = getClient();
  const config = getConfig();

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user' as const, content: userMessage },
  ];

  const response = await client.chat({
    model: config.model,
    messages,
    format: 'json',
    options: {
      temperature: 0.3,
      num_predict: 16384,
      num_ctx: config.numCtx,
    },
  });

  let text = response.message.content.trim();
  console.log('[OllamaService] chatJSONWithHistory raw response:', text);
  // Strip wrapping code fences — only the outer ones, not code blocks inside JSON string values
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '').trim();
  // If that still fails to parse, try extracting the JSON object directly
  try {
    return JSON.parse(text) as T;
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as T;
      } catch { /* fall through */ }
    }
    throw new Error(`Invalid JSON from LLM: ${text.slice(0, 500)}`);
  }
}

/**
 * Send a chat completion request and return the raw text response.
 */
export async function chatText(systemPrompt: string, userMessage: string, temperature = 0.3): Promise<string> {
  const client = getClient();
  const config = getConfig();

  const response = await client.chat({
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    options: {
      temperature,
      num_predict: 16384,
      num_ctx: config.numCtx,
    },
  });

  return response.message.content.trim();
}
