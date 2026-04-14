import React from 'react';
import { PickCell } from './PickCell';
import type { DraftState, Team } from '../types';
import '../styles/board.css';

interface DraftBoardProps {
  state: DraftState | null;
  teams: Record<string, Team>;
}

export function DraftBoard({ state, teams }: DraftBoardProps) {
  if (!state) return <div className="panel draft-board"><p style={{ color: 'var(--text-dim)', padding: 16 }}>Loading...</p></div>;

  const schedule = state.schedule;
  const pickMap = new Map(state.picks.map(p => [p.overall, p]));
  const currentOverall = schedule[state.currentPickIndex]?.overall;

  // Group by round
  const rounds = new Map<number, typeof schedule>();
  for (const slot of schedule) {
    if (!rounds.has(slot.round)) rounds.set(slot.round, []);
    rounds.get(slot.round)!.push(slot);
  }

  return (
    <div className="panel draft-board">
      <div className="section-header">Draft Board</div>
      {Array.from(rounds.entries()).map(([round, slots]) => (
        <div key={round} className="board-round">
          <div className="board-round-label">Round {round}</div>
          {slots.map(slot => (
            <PickCell
              key={slot.overall}
              slot={slot}
              pick={pickMap.get(slot.overall)}
              teams={teams}
              isCurrent={slot.overall === currentOverall && state.status === 'active'}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
