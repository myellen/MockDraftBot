import type { DraftState, BoardData } from './types';

export interface PersistenceProvider {
  loadState(id: string): Promise<DraftState | null>;
  saveState(id: string, state: DraftState): Promise<void>;
  loadBoards(id: string): Promise<BoardData | null>;
  saveBoards(id: string, boards: BoardData): Promise<void>;
}

export interface TimerProvider {
  schedule(ms: number, cb: () => void): string;
  cancel(timerId: string): void;
}
