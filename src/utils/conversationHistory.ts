/** Shared in-memory conversation history (resets on restart). */

export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
}

export class ConversationHistory {
  private store = new Map<string, ConversationEntry[]>();

  constructor(private maxEntries: number) {}

  get(key: string): ConversationEntry[] {
    return this.store.get(key) ?? [];
  }

  add(key: string, role: 'user' | 'assistant', content: string): void {
    const history = this.store.get(key) ?? [];
    history.push({ role, content });
    if (history.length > this.maxEntries) history.splice(0, history.length - this.maxEntries);
    this.store.set(key, history);
  }

  clear(key: string): void {
    this.store.delete(key);
  }
}
