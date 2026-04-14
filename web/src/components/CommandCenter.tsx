import React, { useState, useEffect, useCallback } from 'react';
import { OnTheClock } from './OnTheClock';
import { TradeCenter } from './TradeCenter';
import { TradeAIChat } from './TradeAIChat';
import { BoardAIChat } from './BoardAIChat';
import { Settings } from './Settings';
import { MyTeam } from './MyTeam';
import { BoardManager } from './BoardManager';
import { Inventory } from './Inventory';
import { LeakPanel } from './LeakPanel';
import type { DraftState, Team, CPUOffer, PendingTrade } from '../types';
import '../styles/command.css';

export interface TradeResult {
  trade: PendingTrade;
  accepted: boolean;
  reasoning?: string;
}

interface CommandCenterProps {
  roomCode: string;
  state: DraftState | null;
  teams: Record<string, Team>;
  isAdmin: boolean;
  userId: string;
  cpuOffers?: CPUOffer[];
  onCpuOfferResolved?: (id: string) => void;
  tradeResults?: TradeResult[];
  onDismissResult?: (index: number) => void;
}

type Tab = 'clock' | 'trades' | 'trade-ai' | 'board' | 'board-ai' | 'inventory' | 'leak' | 'settings' | 'team';

export function CommandCenter({ roomCode, state, teams, isAdmin, userId, cpuOffers, onCpuOfferResolved, tradeResults, onDismissResult }: CommandCenterProps) {
  const [tab, setTab] = useState<Tab>('clock');
  const [boardVersion, setBoardVersion] = useState(0);

  // Auto-switch to clock tab when it's the user's turn
  useEffect(() => {
    if (!state || state.status !== 'active') return;
    const slot = state.schedule[state.currentPickIndex];
    if (!slot) return;
    const myTeam = state.assignments[slot.currentTeam] === userId ||
      (state.coManagers[slot.currentTeam] ?? []).includes(userId);
    if (myTeam) setTab('clock');
  }, [state?.currentPickIndex, state?.status]);

  const handleBoardChanged = useCallback(() => {
    setBoardVersion(v => v + 1);
  }, []);

  if (!state) {
    return (
      <div className="panel command-center">
        <div className="command-content">
          <p style={{ color: 'var(--text-dim)', textAlign: 'center', padding: 20 }}>Loading...</p>
        </div>
      </div>
    );
  }

  // Count pending trades for badge
  const myTeamAbbr = Object.entries(state.assignments).find(([, uid]) => uid === userId)?.[0]
    ?? Object.entries(state.coManagers).find(([, uids]) => uids.includes(userId))?.[0]
    ?? null;
  const cpuOffersForMe = (cpuOffers ?? []).filter(o => o.receiverTeam === myTeamAbbr);
  const pendingForMe = state.pendingTrades.filter(t => t.receiverTeam === myTeamAbbr).length + cpuOffersForMe.length;

  return (
    <div className="panel command-center">
      <div className="command-tabs">
        <button className={`command-tab${tab === 'clock' ? ' active' : ''}`} onClick={() => setTab('clock')}>
          On Clock
        </button>
        <button className={`command-tab${tab === 'trades' ? ' active' : ''}`} onClick={() => setTab('trades')}>
          Trades
          {pendingForMe > 0 && <span className="command-tab-badge">{pendingForMe}</span>}
        </button>
        <button className={`command-tab${tab === 'trade-ai' ? ' active' : ''}`} onClick={() => setTab('trade-ai')}>
          Trade AI
        </button>
        <button className={`command-tab${tab === 'board' ? ' active' : ''}`} onClick={() => setTab('board')}>
          Board
        </button>
        <button className={`command-tab${tab === 'board-ai' ? ' active' : ''}`} onClick={() => setTab('board-ai')}>
          Scout AI
        </button>
        <button className={`command-tab${tab === 'inventory' ? ' active' : ''}`} onClick={() => setTab('inventory')}>
          Roster
        </button>
        <button className={`command-tab${tab === 'leak' ? ' active' : ''}`} onClick={() => setTab('leak')}>
          Leak
        </button>
        {isAdmin && (
          <button className={`command-tab${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}>
            Settings
          </button>
        )}
        <button className={`command-tab${tab === 'team' ? ' active' : ''}`} onClick={() => setTab('team')}>
          My Team
        </button>
      </div>
      <div className="command-content">
        {/* Render all tabs but hide inactive ones to preserve state */}
        <div style={{ display: tab === 'clock' ? 'block' : 'none' }}>
          <OnTheClock roomCode={roomCode} state={state} teams={teams} userId={userId} boardVersion={boardVersion} />
        </div>
        <div style={{ display: tab === 'trades' ? 'block' : 'none' }}>
          <TradeCenter roomCode={roomCode} state={state} teams={teams} userId={userId} cpuOffers={cpuOffersForMe} onCpuOfferResolved={onCpuOfferResolved} tradeResults={tradeResults} onDismissResult={onDismissResult} />
        </div>
        <div style={{ display: tab === 'trade-ai' ? 'block' : 'none' }}>
          <TradeAIChat roomCode={roomCode} state={state} teams={teams} userId={userId} />
        </div>
        <div style={{ display: tab === 'board' ? 'block' : 'none' }}>
          <BoardManager roomCode={roomCode} state={state} teams={teams} userId={userId} boardVersion={boardVersion} />
        </div>
        <div style={{ display: tab === 'board-ai' ? 'block' : 'none' }}>
          <BoardAIChat roomCode={roomCode} state={state} teams={teams} userId={userId} onBoardChanged={handleBoardChanged} />
        </div>
        <div style={{ display: tab === 'inventory' ? 'block' : 'none' }}>
          <Inventory roomCode={roomCode} state={state} teams={teams} userId={userId} />
        </div>
        <div style={{ display: tab === 'leak' ? 'block' : 'none' }}>
          <LeakPanel roomCode={roomCode} />
        </div>
        {isAdmin && (
          <div style={{ display: tab === 'settings' ? 'block' : 'none' }}>
            <Settings roomCode={roomCode} state={state} isAdmin={isAdmin} />
          </div>
        )}
        <div style={{ display: tab === 'team' ? 'block' : 'none' }}>
          <MyTeam roomCode={roomCode} state={state} teams={teams} userId={userId} />
        </div>
      </div>
    </div>
  );
}
