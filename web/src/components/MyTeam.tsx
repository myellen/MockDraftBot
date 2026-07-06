import React, { useState } from 'react';
import { schoolLabel } from '../mode';
import * as api from '../api';
import type { DraftState, Team } from '../types';
import { teamColorToCSS } from '../types';

interface MyTeamProps {
  roomCode: string;
  state: DraftState;
  teams: Record<string, Team>;
  userId: string;
}

// NFL divisions with team abbreviations
const DIVISIONS: Array<{ conference: string; division: string; teams: string[] }> = [
  { conference: 'AFC', division: 'East',  teams: ['BUF', 'MIA', 'NE', 'NYJ'] },
  { conference: 'AFC', division: 'North', teams: ['BAL', 'CIN', 'CLE', 'PIT'] },
  { conference: 'AFC', division: 'South', teams: ['HOU', 'IND', 'JAX', 'TEN'] },
  { conference: 'AFC', division: 'West',  teams: ['DEN', 'KC', 'LAC', 'LV'] },
  { conference: 'NFC', division: 'East',  teams: ['DAL', 'NYG', 'PHI', 'WAS'] },
  { conference: 'NFC', division: 'North', teams: ['CHI', 'DET', 'GB', 'MIN'] },
  { conference: 'NFC', division: 'South', teams: ['ATL', 'CAR', 'NO', 'TB'] },
  { conference: 'NFC', division: 'West',  teams: ['ARI', 'LAR', 'SEA', 'SF'] },
];

function teamLogoUrl(abbr: string): string {
  return `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png`;
}

export function MyTeam({ roomCode, state, teams, userId }: MyTeamProps) {
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  // Find user's team
  const myTeam = Object.entries(state.assignments).find(([, uid]) => uid === userId)?.[0]
    ?? Object.entries(state.coManagers).find(([, uids]) => uids.includes(userId))?.[0]
    ?? null;

  const handleRegister = async (abbr: string) => {
    try {
      setLoading(true);
      await api.registerTeam(roomCode, abbr);
      setMsg(`Registered for ${teams[abbr]?.name ?? abbr}!`);
    } catch (err: any) { setMsg(err.message); }
    finally { setLoading(false); }
  };

  // If not registered, show division grid
  if (!myTeam) {
    return (
      <div>
        <div className="section-header">Choose Your Team</div>

        {['AFC', 'NFC'].map(conf => (
          <div key={conf} style={{ marginBottom: 16 }}>
            <div style={{
              fontFamily: 'var(--font-display)', fontSize: '1.2rem', color: 'var(--text-secondary)',
              marginBottom: 8, letterSpacing: '0.05em',
            }}>
              {conf}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {DIVISIONS.filter(d => d.conference === conf).map(div => (
                <div key={div.division} style={{
                  background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)', padding: 8,
                }}>
                  <div style={{
                    fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: '0.65rem',
                    textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)',
                    marginBottom: 6,
                  }}>
                    {conf} {div.division}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                    {div.teams.map(abbr => {
                      const t = teams[abbr];
                      if (!t) return null;
                      const taken = !!state.assignments[abbr];
                      const color = teamColorToCSS(t.color);
                      return (
                        <button
                          key={abbr}
                          onClick={() => !taken && !loading && handleRegister(abbr)}
                          disabled={taken || loading}
                          className="team-select-btn"
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
                            background: taken ? 'var(--bg-deep)' : 'var(--bg-panel)',
                            border: `1px solid ${taken ? 'var(--border-subtle)' : color}`,
                            borderRadius: 'var(--radius-sm)', cursor: taken ? 'default' : 'pointer',
                            opacity: taken ? 0.4 : 1, transition: 'all 0.15s',
                            borderLeft: `3px solid ${color}`,
                          }}
                        >
                          <img
                            src={teamLogoUrl(abbr)}
                            alt={abbr}
                            style={{ width: 24, height: 24, objectFit: 'contain' }}
                            loading="lazy"
                          />
                          <span style={{
                            fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: '0.7rem',
                            color: taken ? 'var(--text-dim)' : 'var(--text-primary)',
                            textAlign: 'left', lineHeight: 1.2,
                          }}>
                            {t.city}
                            {taken && (
                              <span style={{ display: 'block', fontSize: '0.55rem', color: 'var(--text-dim)', fontWeight: 400 }}>
                                Taken
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {msg && <div className={`status-msg ${msg.includes('!') ? 'success' : 'error'}`} style={{ marginTop: 8 }}>{msg}</div>}
      </div>
    );
  }

  // Show team info
  const team = teams[myTeam];
  const teamColor = team ? teamColorToCSS(team.color) : 'var(--accent-info)';
  const myPicks = state.picks.filter(p => p.team === myTeam);
  const upcomingSlots = state.schedule.filter(s =>
    s.currentTeam === myTeam &&
    !state.picks.find(p => p.overall === s.overall)
  );
  const myFuturePicks = state.futurePickRights.filter(f => f.currentTeam === myTeam);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <img
          src={teamLogoUrl(myTeam)}
          alt={myTeam}
          style={{ width: 40, height: 40, objectFit: 'contain' }}
        />
        <div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', color: teamColor }}>
            {team?.name ?? myTeam}
          </div>
        </div>
      </div>

      {/* Drafted players */}
      {myPicks.length > 0 && (
        <div className="my-team-picks">
          <div className="section-header">Drafted Players ({myPicks.length})</div>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Pos</th>
                <th>{schoolLabel()}</th>
              </tr>
            </thead>
            <tbody>
              {myPicks.map(p => (
                <tr key={p.overall}>
                  <td style={{ fontFamily: 'var(--font-display)', color: 'var(--text-dim)' }}>{p.overall}</td>
                  <td style={{ fontFamily: 'var(--font-heading)', fontWeight: 600 }}>{p.prospectName}</td>
                  <td>{p.pos}</td>
                  <td>{p.school}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Upcoming picks */}
      {upcomingSlots.length > 0 && (
        <div className="upcoming-picks">
          <div className="section-header">Upcoming Picks ({upcomingSlots.length})</div>
          {upcomingSlots.map(s => (
            <div key={s.overall} className="upcoming-pick">
              <span className="upcoming-pick-number">#{s.overall}</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                Round {s.round}, Pick {s.roundPick}
              </span>
              {s.isTraded && <span style={{ color: 'var(--accent-trade)', fontSize: '0.7rem' }}>(Traded)</span>}
            </div>
          ))}
        </div>
      )}

      {/* Future pick rights */}
      {myFuturePicks.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="section-header">Future Pick Rights</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {myFuturePicks.map(f => (
              <span key={f.id} className="pick-chip" style={{ cursor: 'default' }}>
                {f.year} R{f.round} {f.originalTeam !== myTeam ? `(via ${f.originalTeam})` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {myPicks.length === 0 && upcomingSlots.length === 0 && (
        <div className="not-your-turn" style={{ padding: 20 }}>
          <p>No picks yet. The draft hasn't started or your team has no remaining picks.</p>
        </div>
      )}
    </div>
  );
}
