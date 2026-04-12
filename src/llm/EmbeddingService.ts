/**
 * In-memory vector index for Beast scouting data.
 * Builds embeddings at startup for prospects with writeup text,
 * then provides cosine-similarity search for qualitative queries.
 */

import { embed } from './OllamaService';
import { isAvailable, getAllProspectsRaw } from '../data/beastScouting';

interface ProspectEmbedding {
  name: string;
  pos: string;
  school: string;
  ovrRank: number | null;
  text: string;
  vector: number[];
}

export interface RagResult {
  name: string;
  pos: string;
  school: string;
  ovrRank: number | null;
  score: number;
  snippet: string;
}

let index: ProspectEmbedding[] = [];
let ready = false;

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function buildTextBlob(p: { name: string; pos: string; school: string; strengths?: string[]; weaknesses?: string[]; summary?: string }): string {
  const parts = [`${p.name} | ${p.pos} | ${p.school}`];
  if (p.strengths?.length) parts.push(`Strengths: ${p.strengths.join('. ')}`);
  if (p.weaknesses?.length) parts.push(`Weaknesses: ${p.weaknesses.join('. ')}`);
  if (p.summary) parts.push(p.summary);
  return parts.join('\n');
}

/** Build the vector index. Call once at startup. */
export async function buildIndex(): Promise<void> {
  if (!isAvailable()) {
    console.warn('[EmbeddingService] Beast data not available, skipping index build');
    return;
  }

  const start = Date.now();
  const prospects = getAllProspectsRaw()
    .filter(p => (p.strengths?.length ?? 0) > 0 || p.summary);

  console.log(`[EmbeddingService] Embedding ${prospects.length} prospects with writeups...`);

  const texts = prospects.map(p => buildTextBlob(p));
  const BATCH_SIZE = 50;
  const allVectors: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const vectors = await embed(batch);
    allVectors.push(...vectors);
  }

  index = prospects.map((p, i) => ({
    name: p.name,
    pos: p.pos,
    school: p.school,
    ovrRank: p.ovrRank,
    text: texts[i],
    vector: allVectors[i],
  }));

  ready = true;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[EmbeddingService] Built index for ${index.length} prospects in ${elapsed}s`);
}

/** Returns true if the embedding index is ready for search. */
export function isReady(): boolean {
  return ready;
}

/** Semantic search against the prospect embedding index.
 *  Optional posFilter restricts results to a specific position (e.g. "WR"). */
export async function search(query: string, topK = 15, posFilter?: string): Promise<RagResult[]> {
  if (!ready || index.length === 0) return [];

  const [queryVector] = await embed(query);
  if (!queryVector) return [];

  const candidates = posFilter
    ? index.filter(e => e.pos.toUpperCase() === posFilter.toUpperCase())
    : index;

  const scored = candidates.map(entry => ({
    ...entry,
    score: cosineSim(queryVector, entry.vector),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK).map(e => ({
    name: e.name,
    pos: e.pos,
    school: e.school,
    ovrRank: e.ovrRank,
    score: Math.round(e.score * 1000) / 1000,
    snippet: e.text.slice(0, 200),
  }));
}
