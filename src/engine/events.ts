import { EventEmitter } from 'events';
import type { CompletedPick, PickSlot, PendingTrade, TradeCancelReason } from './types';
import type { CPUOffer } from './AIGMService';

export interface DraftEventMap {
  'pick:made':           { pick: CompletedPick; slot: PickSlot };
  'pick:clock':          { slot: PickSlot; teamAbbr: string };
  'draft:complete':      { picks: CompletedPick[] };
  'draft:started':       Record<string, never>;
  'draft:paused':        Record<string, never>;
  'draft:resumed':       Record<string, never>;
  'draft:reset':         Record<string, never>;
  'trade:executed':      { trade: PendingTrade };
  'trade:cancelled':     { trade: PendingTrade; reason: TradeCancelReason };
  'trade:chatter':       { team1: string; team2: string; outcome: string; reasoning: string };
  'cpu-offer:sent':      { offer: CPUOffer };
  'cpu-offer:resolved':  { offerId: string; accepted: boolean };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class TypedEventEmitter<M extends { [K in keyof M]: any }> {
  private e = new EventEmitter();
  on<K extends keyof M>(k: K, fn: (p: M[K]) => void): this {
    this.e.on(k as string, fn as (...args: unknown[]) => void);
    return this;
  }
  off<K extends keyof M>(k: K, fn: (p: M[K]) => void): this {
    this.e.off(k as string, fn as (...args: unknown[]) => void);
    return this;
  }
  emit<K extends keyof M>(k: K, p: M[K]): boolean {
    return this.e.emit(k as string, p);
  }
}
