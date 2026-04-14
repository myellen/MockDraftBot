/** Decode a base64url-encoded token payload. */
export function decodeTokenPayload(token: string): any | null {
  try {
    const b64url = token.split('.')[0];
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64));
  } catch { return null; }
}

let _token: string | null = null;

export function setToken(token: string) {
  _token = token;
  localStorage.setItem('draft-token', token);
}

export function getToken(): string | null {
  if (!_token) _token = localStorage.getItem('draft-token');
  return _token;
}

export function clearToken() {
  _token = null;
  localStorage.removeItem('draft-token');
}

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> ?? {}),
  };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json();
  if (!res.ok && !data.success) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

// ─── Room management ─────────────────────────────────────────────────────────

export function createRoom() {
  return apiFetch<{ roomCode: string; token: string }>('/api/rooms', { method: 'POST' });
}

export function joinRoom(code: string, displayName: string) {
  return apiFetch<{ token: string; userId: string }>(`/api/rooms/${code}/join`, {
    method: 'POST',
    body: JSON.stringify({ displayName }),
  });
}

// ─── Draft state ─────────────────────────────────────────────────────────────

export function getState(code: string) {
  return apiFetch<{ state: any; teams: any }>(`/api/rooms/${code}/state`);
}

// ─── Draft commands ──────────────────────────────────────────────────────────

export function setup(code: string, config: Record<string, any>) {
  return apiFetch(`/api/rooms/${code}/setup`, { method: 'POST', body: JSON.stringify(config) });
}

export function startDraft(code: string) {
  return apiFetch(`/api/rooms/${code}/start`, { method: 'POST' });
}

export function pauseDraft(code: string) {
  return apiFetch(`/api/rooms/${code}/pause`, { method: 'POST' });
}

export function resumeDraft(code: string) {
  return apiFetch(`/api/rooms/${code}/resume`, { method: 'POST' });
}

export function resetDraft(code: string) {
  return apiFetch(`/api/rooms/${code}/reset`, { method: 'POST' });
}

export function makePick(code: string, prospectRank: number) {
  return apiFetch(`/api/rooms/${code}/pick`, { method: 'POST', body: JSON.stringify({ prospectRank }) });
}

export function autoPick(code: string) {
  return apiFetch(`/api/rooms/${code}/autopick`, { method: 'POST' });
}

export function registerTeam(code: string, teamAbbr: string) {
  return apiFetch(`/api/rooms/${code}/register`, { method: 'POST', body: JSON.stringify({ teamAbbr }) });
}

// ─── Prospects ──────────────────────────────────────────────────────────────

export function getProspects(code: string, pos?: string, page = 1, pageSize = 50) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (pos) params.set('pos', pos);
  return apiFetch<{ prospects: any[]; totalPages: number; total: number }>(`/api/rooms/${code}/prospects?${params}`);
}

// ─── Trades ─────────────────────────────────────────────────────────────────

export function proposeTrade(code: string, trade: {
  receiverTeam: string;
  offeredOveralls: number[];
  requestedOveralls: number[];
  offeredPlayers?: string[];
  requestedPlayers?: string[];
  offeredFuturePicks?: string[];
  requestedFuturePicks?: string[];
}) {
  return apiFetch(`/api/rooms/${code}/trade/propose`, { method: 'POST', body: JSON.stringify(trade) });
}

export function acceptTrade(code: string, tradeId: string) {
  return apiFetch(`/api/rooms/${code}/trade/accept`, { method: 'POST', body: JSON.stringify({ tradeId }) });
}

export function declineTrade(code: string, tradeId: string) {
  return apiFetch(`/api/rooms/${code}/trade/decline`, { method: 'POST', body: JSON.stringify({ tradeId }) });
}

export function acceptCPUOffer(code: string, offerId: string) {
  return apiFetch(`/api/rooms/${code}/cpu-offer/accept`, { method: 'POST', body: JSON.stringify({ offerId }) });
}

export function declineCPUOffer(code: string, offerId: string) {
  return apiFetch(`/api/rooms/${code}/cpu-offer/decline`, { method: 'POST', body: JSON.stringify({ offerId }) });
}

// ─── Board Management ───────────────────────────────────────────────────────

export function getMyBoard(code: string, page = 1, pageSize = 50) {
  return apiFetch<{ entries: any[]; total: number; totalPages: number; page: number; strategy: string | null; notes: string[] }>(
    `/api/rooms/${code}/board?page=${page}&pageSize=${pageSize}`
  );
}

export function submitBoard(code: string, names: string[]) {
  return apiFetch<{ success: boolean; matched: number; unmatched: string[] }>(
    `/api/rooms/${code}/board/submit`, { method: 'POST', body: JSON.stringify({ names }) }
  );
}

export function clearBoard(code: string, what: 'board' | 'strategy' | 'all' = 'all') {
  return apiFetch(`/api/rooms/${code}/board/clear`, { method: 'POST', body: JSON.stringify({ what }) });
}

export function setStrategy(code: string, prompt: string) {
  return apiFetch(`/api/rooms/${code}/board/strategy`, { method: 'POST', body: JSON.stringify({ prompt }) });
}

export function reorderBoard(code: string, fromIndex: number, toIndex: number) {
  return apiFetch(`/api/rooms/${code}/board/reorder`, { method: 'POST', body: JSON.stringify({ fromIndex, toIndex }) });
}

export function addToBoard(code: string, rank: number, position?: number) {
  return apiFetch(`/api/rooms/${code}/board/add`, { method: 'POST', body: JSON.stringify({ rank, position }) });
}

export function removeFromBoard(code: string, rank: number) {
  return apiFetch(`/api/rooms/${code}/board/remove`, { method: 'POST', body: JSON.stringify({ rank }) });
}

// ─── Inventory ──────────────────────────────────────────────────────────────

export function getInventory(code: string, teamAbbr: string) {
  return apiFetch<{ futurePicks: any[]; futureRights: any[]; draftedPicks: any[]; roster: any[]; capInfo: any }>(
    `/api/rooms/${code}/inventory/${teamAbbr}`
  );
}

// ─── AI Chat ───────────────────────────────────────────────────────────────

export function tradeAI(code: string, message: string) {
  return apiFetch<{ success: boolean; response: any; tradeResult: any }>(`/api/rooms/${code}/trade-ai`, {
    method: 'POST',
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(60_000),
  });
}

export function boardAI(code: string, message: string) {
  return apiFetch<{ success: boolean; response: any; boardResult: any }>(`/api/rooms/${code}/board-ai`, {
    method: 'POST',
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(60_000),
  });
}

export function clearAIHistory(code: string, type: 'trade' | 'board' | 'all') {
  return apiFetch(`/api/rooms/${code}/ai/clear-history`, {
    method: 'POST',
    body: JSON.stringify({ type }),
  });
}

// ─── InsiderX ───────────────────────────────────────────────────────────────

export function triggerRumor(code: string) {
  return apiFetch<{ name: string; handle: string; avatar: string; tweet: string }>(`/api/rooms/${code}/rumor`, { method: 'POST' });
}

// ─── Leak ──────────────────────────────────────────────────────────────────

export function getInsiders(code: string) {
  return apiFetch<{ insiders: Array<{ name: string; handle: string; avatar: string }> }>(`/api/rooms/${code}/insiders`);
}

export function submitLeak(code: string, info: string, insiderName?: string) {
  return apiFetch<{ success: boolean; name: string; handle: string; avatar: string; tweet: string }>(
    `/api/rooms/${code}/leak`, {
      method: 'POST',
      body: JSON.stringify({ info, insiderName }),
      signal: AbortSignal.timeout(30_000),
    },
  );
}
