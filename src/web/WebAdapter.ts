/**
 * Web adapter — mirrors src/discord/DraftManager.ts provider implementations.
 * Implements PersistenceProvider (file-based JSON) and TimerProvider (setTimeout).
 * Broadcasts engine events as JSON over WebSocket to connected clients.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type WebSocket from 'ws';
import {
  DraftState, DraftConfig, CancelledTrade, PendingTrade,
  FuturePickRight, BoardData,
} from '../engine/types';
import { DraftEngine, DEFAULT_STATE, DEFAULT_BOARD_DATA, buildFuturePickRights } from '../engine/DraftEngine';
import type { PersistenceProvider, TimerProvider } from '../engine/interfaces';
import { InsiderQueue } from '../llm/InsiderService';

// ─── File paths (prefixed with web- to avoid collisions with Discord state) ──

function statePath(roomCode: string): string {
  return path.join(__dirname, `../../data/web-draft-state-${roomCode}.json`);
}

function boardPath(roomCode: string): string {
  return path.join(__dirname, `../../data/web-draft-boards-${roomCode}.json`);
}

// ─── WebAdapter ──────────────────────────────────────────────────────────────

export class WebAdapter implements PersistenceProvider, TimerProvider {
  readonly engine: DraftEngine;
  readonly insiderQueue = new InsiderQueue();
  private sockets = new Set<WebSocket>();
  private timerMap = new Map<string, NodeJS.Timeout>();
  private timerCounter = 0;

  private constructor(public readonly roomCode: string, state: DraftState, boardData: BoardData) {
    this.engine = new DraftEngine(roomCode, state, boardData, this, this);
    this.bindEvents();
  }

  static async create(roomCode: string): Promise<WebAdapter> {
    const adapter = Object.create(WebAdapter.prototype) as WebAdapter;
    // Initialize fields before loading (constructor won't run via Object.create)
    (adapter as any).roomCode = roomCode;
    (adapter as any).sockets = new Set<WebSocket>();
    (adapter as any).timerMap = new Map<string, NodeJS.Timeout>();
    (adapter as any).timerCounter = 0;
    (adapter as any).insiderQueue = new InsiderQueue();

    const state = (await adapter.loadState(roomCode)) ?? { ...DEFAULT_STATE };
    const boardData = (await adapter.loadBoards(roomCode)) ?? { ...DEFAULT_BOARD_DATA };
    (adapter as any).engine = new DraftEngine(roomCode, state, boardData, adapter, adapter);
    adapter.bindEvents();
    return adapter;
  }

  // ─── PersistenceProvider (copied from DraftManager) ────────────────────────

  async loadState(id: string): Promise<DraftState | null> {
    try {
      const raw = await fs.readFile(statePath(id), 'utf-8');
      const parsed = JSON.parse(raw) as DraftState;
      if (parsed.schemaVersion !== 1) return null;
      const r = parsed as unknown as Record<string, unknown>;
      const state: DraftState = {
        ...parsed,
        coManagers: (r.coManagers as Record<string, string[]> | undefined) ?? {},
        pendingTrades: (r.pendingTrades as PendingTrade[] | undefined) ?? [],
        tradeHistory: (r.tradeHistory as PendingTrade[] | undefined) ?? [],
        cancelledTrades: (r.cancelledTrades as CancelledTrade[] | undefined) ?? [],
        playerOwnership: (r.playerOwnership as Record<string, string> | undefined) ?? {},
        futurePickRights: (r.futurePickRights as FuturePickRight[] | undefined) ?? buildFuturePickRights(),
        config: {
          ...(parsed.config as DraftConfig),
          rounds: (parsed.config as DraftConfig).rounds ?? 7,
          allowPlayerTrades: (parsed.config as DraftConfig).allowPlayerTrades ?? true,
          tradeAnnouncement: (parsed.config as DraftConfig).tradeAnnouncement ?? 'intrigue',
          enforceSalaryCap: (parsed.config as DraftConfig).enforceSalaryCap ?? false,
          cpuTrading: (parsed.config as DraftConfig).cpuTrading ?? false,
          simulationMode: (parsed.config as DraftConfig).simulationMode ?? false,
          gmExtraResearch: (parsed.config as DraftConfig).gmExtraResearch ?? false,
        },
      };
      state.pendingTrades = state.pendingTrades.map(t => {
        const rt = t as unknown as Record<string, unknown>;
        return {
          ...t,
          offeredPlayers: (rt.offeredPlayers as string[] | undefined) ?? [],
          requestedPlayers: (rt.requestedPlayers as string[] | undefined) ?? [],
          offeredFuturePicks: (rt.offeredFuturePicks as string[] | undefined) ?? [],
          requestedFuturePicks: (rt.requestedFuturePicks as string[] | undefined) ?? [],
        };
      });
      return state;
    } catch {
      return null;
    }
  }

  async saveState(id: string, state: DraftState): Promise<void> {
    const p = statePath(id);
    const tmp = p + `.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tmp, p);
  }

  async loadBoards(id: string): Promise<BoardData | null> {
    try {
      const raw = await fs.readFile(boardPath(id), 'utf-8');
      const parsed = JSON.parse(raw) as BoardData;
      return {
        customBoards: parsed.customBoards ?? {},
        strategyNotes: parsed.strategyNotes ?? {},
        strategyPrompts: (parsed as any).strategyPrompts ?? {},
      };
    } catch {
      return null;
    }
  }

  async saveBoards(id: string, boards: BoardData): Promise<void> {
    const p = boardPath(id);
    const tmp = p + '.tmp';
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(boards, null, 2), 'utf-8');
    await fs.rename(tmp, p);
  }

  // ─── TimerProvider ─────────────────────────────────────────────────────────

  schedule(ms: number, cb: () => void): string {
    const id = String(++this.timerCounter);
    this.timerMap.set(id, setTimeout(cb, ms));
    return id;
  }

  cancel(timerId: string): void {
    const handle = this.timerMap.get(timerId);
    if (handle) {
      clearTimeout(handle);
      this.timerMap.delete(timerId);
    }
  }

  // ─── WebSocket management ──────────────────────────────────────────────────

  addSocket(ws: WebSocket): void {
    this.sockets.add(ws);
    // Send current state snapshot on connect
    const snapshot = JSON.stringify({ event: 'state:snapshot', data: this.engine.getState() });
    ws.send(snapshot);
  }

  removeSocket(ws: WebSocket): void {
    this.sockets.delete(ws);
  }

  get socketCount(): number {
    return this.sockets.size;
  }

  /** Broadcast current state to all connected clients (debounced per microtask) */
  private stateBroadcastPending = false;
  broadcastState(): void {
    if (this.stateBroadcastPending) return;
    this.stateBroadcastPending = true;
    queueMicrotask(() => {
      this.stateBroadcastPending = false;
      this.broadcast('state:snapshot', this.engine.getState());
    });
  }

  private broadcast(event: string, data: unknown): void {
    const msg = JSON.stringify({ event, data });
    for (const ws of this.sockets) {
      if (ws.readyState === 1 /* WebSocket.OPEN */) {
        ws.send(msg);
      }
    }
  }

  // ─── Feed persistence ──────────────────────────────────────────────────────

  private feedSaveTimer: NodeJS.Timeout | null = null;

  private addFeedItem(type: string, data: unknown): void {
    const state = this.engine.getState() as DraftState; // mutable access for feed persistence
    if (!state.feedItems) state.feedItems = [];
    state.feedItems.unshift({
      id: `feed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      timestamp: Date.now(),
      data,
    });
    if (state.feedItems.length > 200) state.feedItems.length = 200;
    // Debounce save to avoid racing with engine.persist()
    if (this.feedSaveTimer) clearTimeout(this.feedSaveTimer);
    this.feedSaveTimer = setTimeout(() => {
      this.feedSaveTimer = null;
      void this.saveState(this.roomCode, this.engine.getState() as DraftState).catch(() => {});
    }, 2000);
  }

  // ─── Event subscriptions → WebSocket broadcast ─────────────────────────────

  private bindEvents(): void {
    this.engine.on('pick:made', (d) => {
      this.broadcast('pick:made', d);
      this.broadcastState();
      this.addFeedItem('pick-made', d.pick);
      this.insiderQueue.enqueue(this.engine, false);
    });
    this.engine.on('pick:clock', (d) => {
      this.broadcast('pick:clock', d);
      this.broadcastState();
    });
    this.engine.on('draft:started', (d) => {
      this.broadcast('draft:started', d);
      this.broadcastState();
    });
    this.engine.on('draft:paused', (d) => {
      this.broadcast('draft:paused', d);
      this.broadcastState();
    });
    this.engine.on('draft:resumed', (d) => {
      this.broadcast('draft:resumed', d);
      this.broadcastState();
    });
    this.engine.on('draft:reset', (d) => {
      this.broadcast('draft:reset', d);
      (this.engine.getState() as DraftState).feedItems = [];
      this.broadcastState();
    });
    this.engine.on('draft:complete', (d) => {
      this.broadcast('draft:complete', d);
      this.broadcastState();
      this.insiderQueue.stop();
    });
    this.engine.on('trade:executed', (d) => {
      this.broadcast('trade:executed', d);
      this.broadcastState();
      this.addFeedItem('trade-executed', d.trade);
      this.insiderQueue.enqueue(this.engine, true);
    });
    this.engine.on('trade:cancelled', (d) => {
      this.broadcast('trade:cancelled', d);
      this.broadcastState();
      this.addFeedItem('trade-cancelled', d);
    });
    this.engine.on('trade:chatter', (d) => {
      this.broadcast('trade:chatter', d);
      this.addFeedItem('trade-chatter', d);
    });
    this.engine.on('cpu-offer:sent', (d) => {
      this.broadcast('cpu-offer:sent', d);
      this.broadcastState();
    });
    this.engine.on('cpu-offer:resolved', (d) => {
      this.broadcast('cpu-offer:resolved', d);
      this.broadcastState();
    });
    this.engine.on('insider:tweet', (d) => {
      this.broadcast('insider:tweet', d);
      this.addFeedItem('insider-tweet', d);
    });
  }
}
