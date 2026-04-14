import React, { useState, useEffect } from 'react';
import * as api from '../api';
import { ProspectList } from './ProspectList';
import type { DraftState, Team } from '../types';
import { teamColorToCSS } from '../types';

function teamLogoUrl(abbr: string): string {
  return `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png`;
}

interface OnTheClockProps {
  roomCode: string;
  state: DraftState;
  teams: Record<string, Team>;
  userId: string;
  boardVersion?: number;
}

interface BoardEntry {
  boardPos: number;
  rank: number;
  name: string;
  pos: string;
  school: string;
  available: boolean;
}

export function OnTheClock({ roomCode, state, teams, userId, boardVersion }: OnTheClockProps) {
  const [selectedRank, setSelectedRank] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [boardEntries, setBoardEntries] = useState<BoardEntry[]>([]);

  const slot = state.schedule[state.currentPickIndex];

  // Check if the current user controls the team on the clock
  const isMyTurn = slot
    ? state.assignments[slot.currentTeam] === userId ||
      (state.coManagers[slot.currentTeam] ?? []).includes(userId)
    : false;

  // Load board when it's my turn
  useEffect(() => {
    if (isMyTurn) {
      api.getMyBoard(roomCode, 1, 20).then(d => setBoardEntries(d.entries)).catch(() => {});
    }
  }, [isMyTurn, roomCode, state.currentPickIndex, boardVersion]);

  const handlePick = async () => {
    if (!selectedRank) return;
    try {
      setLoading(true);
      setMsg('');
      await api.makePick(roomCode, selectedRank);
      setSelectedRank(null);
      setMsg('Pick submitted!');
    } catch (err: any) {
      setMsg(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAutopick = async () => {
    try {
      setLoading(true);
      setMsg('');
      await api.autoPick(roomCode);
      setMsg('Autopicked!');
    } catch (err: any) {
      setMsg(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (state.status === 'idle') {
    return (
      <div className="not-your-turn">
        <h3>Draft is idle</h3>
        <p>Configure settings and start the draft.</p>
      </div>
    );
  }

  if (state.status === 'complete') {
    return (
      <div className="not-your-turn">
        <h3>Draft Complete</h3>
        <p>All picks are in!</p>
      </div>
    );
  }

  if (!slot) return null;

  const isPaused = state.status === 'paused';
  const team = teams[slot.currentTeam];
  const teamName = team?.name ?? slot.currentTeam;
  const teamColor = team ? teamColorToCSS(team.color) : 'var(--accent-clock)';

  // Recent picks (last 5)
  const recentPicks = state.picks.slice(-5).reverse();

  // Upcoming picks (next 8 after current)
  const upcomingSlots = state.schedule.slice(state.currentPickIndex + 1, state.currentPickIndex + 9);

  // Board entries that are still available (for quick-pick)
  const availableBoard = boardEntries.filter(e => e.available).slice(0, 8);

  return (
    <div className="on-clock-panel">
      <div className="on-clock-info">
        {isPaused && <div style={{ color: 'var(--accent-breaking)', fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Draft Paused</div>}
        <div className="on-clock-team" style={{ color: teamColor, display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src={teamLogoUrl(slot.currentTeam)} alt={slot.currentTeam} style={{ width: 28, height: 28, objectFit: 'contain' }} />
          {teamName}
        </div>
        <div className="on-clock-pick">
          Round {slot.round}, Pick {slot.roundPick} (Overall #{slot.overall})
          {slot.isTraded && <span style={{ color: 'var(--accent-trade)', marginLeft: 8 }}>(Traded)</span>}
        </div>
      </div>

      {isPaused ? (
        <div className="not-your-turn" style={{ padding: '12px 0' }}>
          <p>Waiting for admin to resume.</p>
        </div>
      ) : isMyTurn ? (
        <>
          <div className="on-clock-actions">
            <button className="primary" onClick={handlePick} disabled={!selectedRank || loading}>
              {loading ? 'Submitting...' : selectedRank ? `Draft #${selectedRank}` : 'Select a Prospect'}
            </button>
            <button onClick={handleAutopick} disabled={loading}>Autopick</button>
          </div>
          {msg && <div className={`status-msg ${msg.includes('!') ? 'success' : 'error'}`}>{msg}</div>}

          {/* My Board - Quick Pick */}
          {availableBoard.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div className="section-header">My Board</div>
              <table className="prospect-table">
                <thead>
                  <tr><th>#</th><th>Name</th><th>Pos</th><th></th></tr>
                </thead>
                <tbody>
                  {availableBoard.map(e => (
                    <tr key={e.rank} className={selectedRank === e.rank ? 'selected' : ''}>
                      <td><span className="prospect-rank">{e.boardPos}</span></td>
                      <td><span className="prospect-name">{e.name}</span></td>
                      <td>{e.pos}</td>
                      <td>
                        <button
                          className="prospect-draft-btn primary"
                          onClick={() => setSelectedRank(e.rank)}
                          style={{ fontSize: '0.6rem' }}
                        >
                          {selectedRank === e.rank ? 'Selected' : 'Pick'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="section-header">Available Prospects</div>
          <ProspectList roomCode={roomCode} onSelect={setSelectedRank} selectedRank={selectedRank} />
        </>
      ) : (
        <div className="not-your-turn" style={{ padding: '16px 0' }}>
          <h3>Waiting for {teamName}</h3>
          <p>This team is on the clock.</p>
        </div>
      )}

      {/* Recent Picks */}
      {recentPicks.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="section-header">Recent Picks</div>
          <table className="prospect-table">
            <thead>
              <tr><th>#</th><th>Team</th><th>Player</th><th>Pos</th></tr>
            </thead>
            <tbody>
              {recentPicks.map(p => {
                const t = teams[p.team];
                return (
                  <tr key={p.overall}>
                    <td><span className="prospect-rank">{p.overall}</span></td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <img src={teamLogoUrl(p.team)} alt={p.team} style={{ width: 18, height: 18, objectFit: 'contain', flexShrink: 0 }} />
                        <span style={{ fontSize: '0.75rem' }}>{t?.abbr ?? p.team}</span>
                      </span>
                    </td>
                    <td><span className="prospect-name">{p.prospectName}</span></td>
                    <td>{p.pos}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Upcoming Picks */}
      {upcomingSlots.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="section-header">Up Next</div>
          <div>
            {upcomingSlots.map(s => {
              const t = teams[s.currentTeam];
              const isMine = state.assignments[s.currentTeam] === userId ||
                (state.coManagers[s.currentTeam] ?? []).includes(userId);
              return (
                <div key={s.overall} className="upcoming-pick" style={isMine ? { background: 'rgba(59,130,246,0.06)' } : {}}>
                  <span className="upcoming-pick-number">#{s.overall}</span>
                  <img src={teamLogoUrl(s.currentTeam)} alt={s.currentTeam} style={{ width: 18, height: 18, objectFit: 'contain', flexShrink: 0 }} />
                  <span style={{
                    fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: '0.8rem',
                    color: isMine ? 'var(--accent-info)' : 'var(--text-secondary)',
                  }}>
                    {t?.name ?? s.currentTeam}
                  </span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginLeft: 'auto' }}>
                    R{s.round}.{s.roundPick}
                  </span>
                  {s.isTraded && <span style={{ fontSize: '0.6rem', color: 'var(--accent-trade)' }}>TRD</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
