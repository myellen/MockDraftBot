import React, { useState, useEffect } from 'react';
import * as api from '../api';
import type { DraftState, Team } from '../types';
import { teamColorToCSS } from '../types';

interface InventoryProps {
  roomCode: string;
  state: DraftState;
  teams: Record<string, Team>;
  userId: string;
}

interface CapInfo {
  capUsed: number;
  capSpace: number;
  deadMoney: number;
  projectedRookieCap: number;
  effectiveCapSpace: number;
}

const POS_GROUPS: Record<string, string[]> = {
  'QB': ['QB'],
  'RB': ['RB', 'FB'],
  'WR': ['WR'],
  'TE': ['TE'],
  'OL': ['OT', 'OG', 'C', 'G', 'T'],
  'DL': ['DE', 'DT', 'NT', 'EDGE'],
  'LB': ['LB', 'ILB', 'OLB', 'MLB'],
  'DB': ['CB', 'S', 'FS', 'SS'],
  'ST': ['K', 'P', 'LS'],
};

function fmtCap(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

export function Inventory({ roomCode, state, teams, userId }: InventoryProps) {
  const [selectedTeam, setSelectedTeam] = useState('');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const myTeam = Object.entries(state.assignments).find(([, uid]) => uid === userId)?.[0]
    ?? Object.entries(state.coManagers).find(([, uids]) => uids.includes(userId))?.[0]
    ?? null;

  useEffect(() => { if (myTeam && !selectedTeam) setSelectedTeam(myTeam); }, [myTeam]);

  useEffect(() => {
    if (!selectedTeam) return;
    setLoading(true);
    api.getInventory(roomCode, selectedTeam).then(d => {
      setData(d);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [roomCode, selectedTeam]);

  const team = teams[selectedTeam];
  const color = team ? teamColorToCSS(team.color) : 'var(--accent-info)';

  // Group roster by position
  const roster = data?.roster ?? [];
  const grouped: Record<string, Array<{ name: string; pos: string; number: string | null }>> = {};
  for (const [group, positions] of Object.entries(POS_GROUPS)) {
    const players = roster.filter((p: any) => positions.includes(p.pos?.toUpperCase()));
    if (players.length > 0) grouped[group] = players;
  }
  const ungrouped = roster.filter((p: any) => !Object.values(POS_GROUPS).flat().includes(p.pos?.toUpperCase()));
  if (ungrouped.length > 0) grouped['Other'] = ungrouped;

  return (
    <div>
      {/* Team selector */}
      <div style={{ marginBottom: 12 }}>
        <select value={selectedTeam} onChange={e => setSelectedTeam(e.target.value)} style={{ width: '100%' }}>
          <option value="">Select a team...</option>
          {Object.keys(teams).sort((a, b) => teams[a].name.localeCompare(teams[b].name)).map(a => (
            <option key={a} value={a}>{teams[a].name}{state.assignments[a] ? '' : ' (CPU)'}</option>
          ))}
        </select>
      </div>

      {loading && <p style={{ color: 'var(--text-dim)', textAlign: 'center' }}>Loading...</p>}

      {data && !loading && (
        <>
          {/* Header with team color */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <div style={{ width: 14, height: 14, borderRadius: 3, background: color }} />
            <h3>{team?.name ?? selectedTeam}</h3>
          </div>

          {/* Draft Picks */}
          {data.futurePicks.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div className="section-header">Remaining Picks</div>
              <div className="pick-chips">
                {data.futurePicks.map((s: any) => (
                  <span key={s.overall} className="pick-chip" style={{ cursor: 'default' }}>
                    #{s.overall} (R{s.round}.{s.roundPick})
                    {s.isTraded && s.originalTeam !== selectedTeam ? ` via ${s.originalTeam}` : ''}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Drafted Players */}
          {data.draftedPicks.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div className="section-header">Drafted Players ({data.draftedPicks.length})</div>
              <table className="prospect-table">
                <thead>
                  <tr><th>#</th><th>Player</th><th>Pos</th></tr>
                </thead>
                <tbody>
                  {data.draftedPicks.map((p: any) => (
                    <tr key={p.overall}>
                      <td><span className="prospect-rank">{p.overall}</span></td>
                      <td><span className="prospect-name">{p.prospectName}</span></td>
                      <td>{p.pos}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Future Pick Rights */}
          {data.futureRights.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div className="section-header">Future Pick Rights</div>
              {[2027, 2028].map(year => {
                const yearPicks = data.futureRights.filter((f: any) => f.year === year);
                if (yearPicks.length === 0) return null;
                return (
                  <div key={year} style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-heading)', fontWeight: 600, color: 'var(--text-dim)' }}>{year}:</span>
                    <div className="pick-chips" style={{ marginTop: 4 }}>
                      {yearPicks.map((f: any) => (
                        <span key={f.id} className="pick-chip" style={{ cursor: 'default' }}>
                          R{f.round}{f.originalTeam !== selectedTeam ? ` (via ${f.originalTeam})` : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Cap Info */}
          {data.capInfo && data.capInfo.capSpace !== 0 && (
            <div style={{ marginBottom: 16 }}>
              <div className="section-header">Salary Cap</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  ['Cap Space', fmtCap(data.capInfo.capSpace)],
                  ['Cap Used', fmtCap(data.capInfo.capUsed)],
                  ['Dead Money', fmtCap(data.capInfo.deadMoney)],
                  ['Effective', fmtCap(data.capInfo.effectiveCapSpace)],
                ].map(([label, val]) => (
                  <div key={label} style={{ padding: 8, background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', fontFamily: 'var(--font-heading)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                    <div style={{ fontSize: '1rem', fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>{val}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Roster */}
          {Object.keys(grouped).length > 0 && (
            <div>
              <div className="section-header">Roster</div>
              {Object.entries(grouped).map(([group, players]) => (
                <div key={group} style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: '0.7rem', fontFamily: 'var(--font-heading)', fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    {group} ({players.length})
                  </span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {players.map((p: any, i: number) => (
                      <span key={i} style={{
                        fontSize: '0.75rem', padding: '2px 8px', background: 'var(--bg-card)',
                        border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)',
                        color: 'var(--text-secondary)',
                      }}>
                        {p.number ? `#${p.number} ` : ''}{p.name}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
