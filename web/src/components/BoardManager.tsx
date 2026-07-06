import React, { useState, useEffect, useCallback } from 'react';
import { schoolLabel } from '../mode';
import * as api from '../api';
import type { DraftState, Team, Prospect } from '../types';

interface BoardManagerProps {
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

export function BoardManager({ roomCode, state, teams, userId, boardVersion }: BoardManagerProps) {
  const [entries, setEntries] = useState<BoardEntry[]>([]);
  const [strategy, setStrategy] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState<'board' | 'add' | 'text' | 'strategy'>('board');
  const [textInput, setTextInput] = useState('');
  const [strategyInput, setStrategyInput] = useState('');
  const [searchResults, setSearchResults] = useState<Prospect[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchPos, setSearchPos] = useState('');

  const myTeam = Object.entries(state.assignments).find(([, uid]) => uid === userId)?.[0]
    ?? Object.entries(state.coManagers).find(([, uids]) => uids.includes(userId))?.[0]
    ?? null;

  const loadBoard = useCallback(() => {
    if (!myTeam) return;
    api.getMyBoard(roomCode, 1, 500).then(d => {
      setEntries(d.entries);
      setTotal(d.total);
      setStrategy(d.strategy);
      setNotes(d.notes);
      if (d.strategy) setStrategyInput(d.strategy);
    });
  }, [roomCode, myTeam]);

  useEffect(() => { loadBoard(); }, [loadBoard, boardVersion]);

  // Pre-fill paste list with effective board when switching to text tab
  useEffect(() => {
    if (tab === 'text' && !textInput && entries.length > 0) {
      setTextInput(entries.map((e, i) => `${i + 1}. ${e.name} (${e.pos})`).join('\n'));
    }
  }, [tab, entries]);

  const handleMoveUp = async (idx: number) => {
    if (idx <= 0) return;
    await api.reorderBoard(roomCode, idx, idx - 1);
    loadBoard();
  };

  const handleMoveDown = async (idx: number) => {
    if (idx >= entries.length - 1) return;
    await api.reorderBoard(roomCode, idx, idx + 1);
    loadBoard();
  };

  const handleRemove = async (rank: number) => {
    await api.removeFromBoard(roomCode, rank);
    loadBoard();
    setMsg('Removed from board.');
  };

  const handleAddToBoard = async (rank: number) => {
    try {
      await api.addToBoard(roomCode, rank);
      loadBoard();
      setMsg('Added to board!');
    } catch (err: any) { setMsg(err.message); }
  };

  const handleTextSubmit = async () => {
    const names = textInput.split('\n')
      .map(l => l.replace(/^\d+[\.\)]\s*/, '').replace(/\s*\(.*\)\s*$/, '').trim())
      .filter(Boolean);
    if (names.length === 0) return;
    try {
      const result = await api.submitBoard(roomCode, names);
      setMsg(`Matched ${result.matched} prospects.${result.unmatched.length > 0 ? ` Unmatched: ${result.unmatched.join(', ')}` : ''}`);
      setTextInput('');
      loadBoard();
      setTab('board');
    } catch (err: any) { setMsg(err.message); }
  };

  const handleClearBoard = async () => {
    await api.clearBoard(roomCode, 'board');
    loadBoard();
    setMsg('Board cleared.');
  };

  const handleSaveStrategy = async () => {
    if (!strategyInput.trim()) return;
    try {
      await api.setStrategy(roomCode, strategyInput.trim());
      setMsg('Strategy saved!');
      loadBoard();
    } catch (err: any) { setMsg(err.message); }
  };

  const handleSearch = async () => {
    const results = await api.getProspects(roomCode, searchPos || undefined, 1, 30);
    let filtered = results.prospects;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter((p: Prospect) => p.name.toLowerCase().includes(q));
    }
    setSearchResults(filtered);
  };

  useEffect(() => { if (tab === 'add') handleSearch(); }, [searchPos, tab]);

  if (!myTeam) {
    return (
      <div className="not-your-turn" style={{ padding: 20 }}>
        <p>Register for a team first to manage your board.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 12, borderBottom: '1px solid var(--border-subtle)' }}>
        {(['board', 'add', 'text', 'strategy'] as const).map(t => (
          <button
            key={t}
            className={`command-tab${tab === t ? ' active' : ''}`}
            style={{ flex: 'none', padding: '8px 14px', fontSize: '0.7rem' }}
            onClick={() => setTab(t)}
          >
            {t === 'board' ? `My Board (${total})` : t === 'add' ? 'Add Players' : t === 'text' ? 'Paste List' : 'Strategy'}
          </button>
        ))}
      </div>

      {msg && <div className={`status-msg ${msg.includes('!') || msg.includes('Matched') ? 'success' : 'error'}`} style={{ marginBottom: 8 }}>{msg}</div>}

      {/* Board view with reorder/remove */}
      {tab === 'board' && (
        <div>
          {entries.length === 0 ? (
            <div className="not-your-turn" style={{ padding: 20 }}>
              <p>No custom board yet. Add players or paste a list.</p>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{total} players</span>
                <button className="danger" onClick={handleClearBoard} style={{ fontSize: '0.65rem', padding: '2px 8px' }}>Clear All</button>
              </div>
              <table className="prospect-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Rk</th>
                    <th>Name</th>
                    <th>Pos</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr key={e.rank} style={{ opacity: e.available ? 1 : 0.4 }}>
                      <td style={{ fontFamily: 'var(--font-display)', color: 'var(--text-dim)', fontSize: '0.8rem' }}>{e.boardPos}</td>
                      <td><span className="prospect-rank">{e.rank}</span></td>
                      <td><span className="prospect-name">{e.name}</span></td>
                      <td>{e.pos}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button onClick={() => handleMoveUp(i)} disabled={i === 0} style={{ fontSize: '0.6rem', padding: '1px 5px', marginRight: 2 }}>^</button>
                        <button onClick={() => handleMoveDown(i)} disabled={i === entries.length - 1} style={{ fontSize: '0.6rem', padding: '1px 5px', marginRight: 2 }}>v</button>
                        <button className="danger" onClick={() => handleRemove(e.rank)} style={{ fontSize: '0.6rem', padding: '1px 5px' }}>x</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {/* Add from available prospects */}
      {tab === 'add' && (
        <div>
          <div className="prospect-search">
            <input placeholder="Search by name..." value={searchQuery} onChange={e => { setSearchQuery(e.target.value); }} onKeyDown={e => e.key === 'Enter' && handleSearch()} />
            <button onClick={handleSearch} style={{ fontSize: '0.7rem' }}>Search</button>
          </div>
          <div className="position-pills" style={{ marginBottom: 8 }}>
            <button className={`pos-pill${!searchPos ? ' active' : ''}`} onClick={() => setSearchPos('')}>All</button>
            {['QB', 'RB', 'WR', 'TE', 'OT', 'EDGE', 'DT', 'LB', 'CB', 'S'].map(p => (
              <button key={p} className={`pos-pill${searchPos === p ? ' active' : ''}`} onClick={() => setSearchPos(searchPos === p ? '' : p)}>{p}</button>
            ))}
          </div>
          <table className="prospect-table">
            <thead>
              <tr><th>Rk</th><th>Name</th><th>Pos</th><th>{schoolLabel()}</th><th></th></tr>
            </thead>
            <tbody>
              {searchResults.map((p: Prospect) => {
                const onBoard = entries.some(e => e.rank === p.rank);
                return (
                  <tr key={p.rank}>
                    <td><span className="prospect-rank">{p.rank}</span></td>
                    <td><span className="prospect-name">{p.name}</span></td>
                    <td>{p.pos}</td>
                    <td>{p.school}</td>
                    <td>
                      <button
                        className="prospect-draft-btn primary"
                        onClick={() => handleAddToBoard(p.rank)}
                        disabled={onBoard}
                      >
                        {onBoard ? 'On Board' : '+ Add'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Paste text list */}
      {tab === 'text' && (
        <div>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            Paste a list of player names (one per line). Numbers and positions in parentheses are stripped automatically.
          </p>
          <textarea
            value={textInput}
            onChange={e => setTextInput(e.target.value)}
            placeholder={"1. Caleb Downs\n2. Malachi Starks (S)\n3. Travis Hunter"}
            rows={12}
            style={{
              width: '100%', fontFamily: 'var(--font-body)', fontSize: '0.8rem',
              padding: 10, background: 'var(--bg-deep)', color: 'var(--text-primary)',
              border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
              resize: 'vertical',
            }}
          />
          <button className="primary" onClick={handleTextSubmit} style={{ width: '100%', marginTop: 8 }}>
            Submit Board
          </button>
        </div>
      )}

      {/* Strategy prompt */}
      {tab === 'strategy' && (
        <div>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
            Set a natural language strategy for autopick AI. Describe your team's priorities, preferred positions, and drafting philosophy.
          </p>
          <textarea
            value={strategyInput}
            onChange={e => setStrategyInput(e.target.value)}
            placeholder="Prioritize EDGE and CB. Value athletic upside over production. Target best player available in rounds 1-3, then fill needs."
            rows={5}
            style={{
              width: '100%', fontFamily: 'var(--font-body)', fontSize: '0.8rem',
              padding: 10, background: 'var(--bg-deep)', color: 'var(--text-primary)',
              border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
              resize: 'vertical',
            }}
          />
          <button className="primary" onClick={handleSaveStrategy} style={{ width: '100%', marginTop: 8 }}>
            Save Strategy
          </button>
          {strategy && (
            <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
              <div className="section-header" style={{ marginBottom: 6 }}>Current Strategy</div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{strategy}</p>
            </div>
          )}
          {notes.length > 0 && (
            <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
              <div className="section-header" style={{ marginBottom: 6 }}>GM Notes</div>
              {notes.map((n, i) => (
                <p key={i} style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: 4 }}>{n}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
