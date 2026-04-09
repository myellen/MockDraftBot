import { Ollama } from 'ollama';

export interface OllamaConfig {
  host: string;       // e.g. "http://localhost:11434" or "https://ollama.com"
  apiKey?: string;     // required for Ollama Cloud
  model: string;       // e.g. "llama3.1", "deepseek-v3.1:671b-cloud"
}

let instance: Ollama | null = null;
let currentConfig: OllamaConfig | null = null;

function getConfig(): OllamaConfig {
  if (currentConfig) return currentConfig;
  currentConfig = {
    host: process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    apiKey: process.env.OLLAMA_API_KEY,
    model: process.env.OLLAMA_MODEL ?? 'llama3.1',
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
    },
  });

  let text = response.message.content.trim();
  console.log('[OllamaService] chatJSON raw response:', text);
  // Strip markdown code fences if the model wraps its JSON output
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '').trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON from LLM: ${text.slice(0, 500)}`);
  }
}

/**
 * Send a chat completion request and return the raw text response.
 */
export async function chatText(systemPrompt: string, userMessage: string): Promise<string> {
  const client = getClient();
  const config = getConfig();

  const response = await client.chat({
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    options: {
      temperature: 0.3,
      num_predict: 16384,
    },
  });

  return response.message.content.trim();
}
