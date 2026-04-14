import React, { useState, useEffect } from 'react';
import * as api from '../api';
import type { DraftState, Team, PendingTrade, CPUOffer } from '../types';
import type { TradeResult } from './CommandCenter';

interface TradeCenterProps {
  roomCode: string;
  state: DraftState;
  teams: Record<string, Team>;
  userId: string;
  cpuOffers?: CPUOffer[];
  onCpuOfferResolved?: (id: string) => void;
  tradeResults?: TradeResult[];
  onDismissResult?: (index: number) => void;
}

export function TradeCenter({ roomCode, state, teams, userId, cpuOffers, onCpuOfferResolved, tradeResults, onDismissResult }: TradeCenterProps) {
  const [msg, setMsg] = useState('');

  // Find user's team
  const myTeam = Object.entries(state.assignments).find(([, uid]) => uid === userId)?.[0]
    ?? Object.entries(state.coManagers).find(([, uids]) => uids.includes(userId))?.[0]
    ?? null;

  // Pending trades involving the user
  const myPending = state.pendingTrades.filter(t =>
    t.receiverTeam === myTeam || t.proposerTeam === myTeam
  );
  const otherPending = state.pendingTrades.filter(t =>
    t.receiverTeam !== myTeam && t.proposerTeam !== myTeam
  );

  // Build slot lookup for round numbers
  const slotMap = new Map(state.schedule.map(s => [s.overall, s]));

  const handleAccept = async (tradeId: string) => {
    try { await api.acceptTrade(roomCode, tradeId); setMsg('Trade accepted!'); }
    catch (err: any) { setMsg(err.message); }
  };

  const handleDecline = async (tradeId: string) => {
    try { await api.declineTrade(roomCode, tradeId); setMsg('Trade declined.'); }
    catch (err: any) { setMsg(err.message); }
  };

  const handleCpuAccept = async (offerId: string) => {
    try {
      await api.acceptCPUOffer(roomCode, offerId);
      onCpuOfferResolved?.(offerId);
      setMsg('Trade accepted!');
    } catch (err: any) { setMsg(err.message); }
  };

  const handleCpuDecline = async (offerId: string) => {
    try {
      await api.declineCPUOffer(roomCode, offerId);
      onCpuOfferResolved?.(offerId);
      setMsg('Trade declined.');
    } catch (err: any) { setMsg(err.message); }
  };

  const formatTradeAssets = (overalls: number[], players: string[], futures: string[], offeringTeam?: string) => {
    const parts: string[] = [];
    for (const o of overalls) {
      const s = slotMap.get(o);
      parts.push(s ? `R${s.round} Pick #${o}` : `Pick #${o}`);
    }
    for (const p of players) parts.push(p);
    for (const fp of futures) {
      const s = String(fp);
      // Full ID: "2027-R1-PHI" → "2027 R1 (PHI)"
      const m = s.match(/^(\d{4})-(R\d)(?:-(.+))?$/);
      if (m) {
        const via = m[3] ? ` (${m[3]})` : '';
        parts.push(`${m[1]} ${m[2]}${via}`);
      } else if (/^\d{4}$/.test(s)) {
        // Bare year from LLM — resolve against futurePickRights using offering team
        const year = parseInt(s);
        const rights = state.futurePickRights ?? [];
        // Look for the team's own pick first, then any pick they hold for that year
        const ownPick = rights.find(f => f.year === year && f.originalTeam === offeringTeam);
        const anyPick = rights.find(f => f.year === year && f.currentTeam === offeringTeam);
        const resolved = ownPick ?? anyPick;
        if (resolved) {
          const via = resolved.originalTeam !== offeringTeam ? ` (${resolved.originalTeam})` : ` (${resolved.originalTeam})`;
          parts.push(`${year} R${resolved.round}${via}`);
        } else {
          parts.push(`${s} future pick`);
        }
      } else {
        parts.push(s);
      }
    }
    return parts.join(' + ') || '(nothing)';
  };

  const cpuOffersForMe = (cpuOffers ?? []).filter(o => o.receiverTeam === myTeam);

  return (
    <div>
      {/* CPU AI Offers */}
      {cpuOffersForMe.length > 0 && (
        <div className="trade-section">
          <div className="section-header">AI GM Offers ({cpuOffersForMe.length})</div>
          {cpuOffersForMe.map(o => {
            const proposerName = teams[o.proposerTeam]?.name ?? o.proposerTeam;
            const receiverName = teams[o.receiverTeam]?.name ?? o.receiverTeam;
            return (
              <div key={o.id} className="trade-card cpu-offer-card">
                <div className="trade-card-header">
                  <span className="trade-card-teams">{proposerName} {o.isCounter ? '(counter)' : ''}</span>
                  <span style={{ fontSize: '0.6rem', color: 'var(--accent-clock)', fontFamily: 'var(--font-heading)', textTransform: 'uppercase' as const }}>AI Offer</span>
                </div>
                {o.pitch && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', fontStyle: 'italic', marginBottom: 8, lineHeight: 1.4 }}>
                    "{o.pitch}"
                  </div>
                )}
                <div className="trade-card-details">
                  <strong>{proposerName}</strong> offers: {formatTradeAssets(o.offeredOveralls, o.offeredPlayers, o.offeredFuturePicks, o.proposerTeam)}
                  <br />
                  <strong>{receiverName}</strong> offers: {formatTradeAssets(o.requestedOveralls, o.requestedPlayers, o.requestedFuturePicks, o.receiverTeam)}
                </div>
                <div className="trade-card-actions">
                  <button className="success" onClick={() => handleCpuAccept(o.id)}>Accept</button>
                  <button className="danger" onClick={() => handleCpuDecline(o.id)}>Decline</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Trade results (accepted/declined with reasoning) */}
      {(tradeResults ?? []).filter(r => r.trade.proposerTeam === myTeam || r.trade.receiverTeam === myTeam).length > 0 && (
        <div className="trade-section">
          <div className="section-header">Trade Results</div>
          {(tradeResults ?? []).map((r, i) => {
            if (r.trade.proposerTeam !== myTeam && r.trade.receiverTeam !== myTeam) return null;
            const t1 = teams[r.trade.proposerTeam]?.name ?? r.trade.proposerTeam;
            const t2 = teams[r.trade.receiverTeam]?.name ?? r.trade.receiverTeam;
            return (
              <div key={`result-${i}`} className={`trade-card ${r.accepted ? 'trade-result-accepted' : 'trade-result-declined'}`}>
                <div className="trade-card-header">
                  <span className="trade-card-teams">{t1} → {t2}</span>
                  <span style={{ fontSize: '0.6rem', fontFamily: 'var(--font-heading)', textTransform: 'uppercase' as const, color: r.accepted ? 'var(--accent-trade)' : 'var(--accent-breaking)' }}>
                    {r.accepted ? 'ACCEPTED' : 'DECLINED'}
                  </span>
                </div>
                <div className="trade-card-details">
                  <strong>{t1}</strong> offers: {formatTradeAssets(r.trade.offeredOveralls, r.trade.offeredPlayers, r.trade.offeredFuturePicks, r.trade.proposerTeam)}
                  <br />
                  <strong>{t2}</strong> offers: {formatTradeAssets(r.trade.requestedOveralls, r.trade.requestedPlayers, r.trade.requestedFuturePicks, r.trade.receiverTeam)}
                </div>
                {r.reasoning && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', fontStyle: 'italic', marginTop: 6, lineHeight: 1.4 }}>
                    "{r.reasoning}"
                  </div>
                )}
                <div className="trade-card-actions" style={{ marginTop: 8 }}>
                  <button onClick={() => onDismissResult?.(i)}>Dismiss</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Incoming trades */}
      {myPending.length > 0 && (
        <div className="trade-section">
          <div className="section-header">Your Trades</div>
          {myPending.map(t => (
            <TradeCard
              key={t.id}
              trade={t}
              teams={teams}
              myTeam={myTeam}
              formatAssets={formatTradeAssets}
              onAccept={handleAccept}
              onDecline={handleDecline}
            />
          ))}
        </div>
      )}

      {/* Other pending */}
      {otherPending.length > 0 && (
        <div className="trade-section">
          <div className="section-header">Other Pending Trades</div>
          {otherPending.map(t => (
            <TradeCard
              key={t.id}
              trade={t}
              teams={teams}
              myTeam={null}
              formatAssets={formatTradeAssets}
              onAccept={handleAccept}
              onDecline={handleDecline}
            />
          ))}
        </div>
      )}

      {myPending.length === 0 && otherPending.length === 0 && cpuOffersForMe.length === 0 && (
        <div className="not-your-turn" style={{ padding: 20 }}>
          <p>No pending trades.</p>
        </div>
      )}

      {/* Propose Trade */}
      {myTeam && state.status === 'active' && (
        <TradeProposalForm
          roomCode={roomCode}
          state={state}
          teams={teams}
          myTeam={myTeam}
          onMsg={setMsg}
        />
      )}

      {/* Trade History */}
      {state.tradeHistory.length > 0 && (
        <div className="trade-section">
          <div className="section-header">Trade History ({state.tradeHistory.length})</div>
          {[...state.tradeHistory].reverse().map(t => {
            const t1 = teams[t.proposerTeam]?.name ?? t.proposerTeam;
            const t2 = teams[t.receiverTeam]?.name ?? t.receiverTeam;
            return (
              <div key={t.id} className="trade-card" style={{ opacity: 0.7 }}>
                <div className="trade-card-details">
                  <strong>{t1}</strong> sent {formatTradeAssets(t.offeredOveralls, t.offeredPlayers, t.offeredFuturePicks, t.proposerTeam)}
                  <br />
                  <strong>{t2}</strong> sent {formatTradeAssets(t.requestedOveralls, t.requestedPlayers, t.requestedFuturePicks, t.receiverTeam)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Trade Leaderboards */}
      <TradeLeaderboards state={state} teams={teams} />

      {msg && <div className={`status-msg ${msg.includes('!') ? 'success' : 'error'}`}>{msg}</div>}
    </div>
  );
}

function TradeLeaderboards({ state, teams }: { state: DraftState; teams: Record<string, Team> }) {
  const history = state.tradeHistory;
  const cancelled = state.cancelledTrades;
  if (history.length === 0 && cancelled.length === 0) return null;

  const medals = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];

  // Trade count leaderboard
  const tradeCounts = new Map<string, number>();
  for (const t of history) {
    tradeCounts.set(t.proposerTeam, (tradeCounts.get(t.proposerTeam) ?? 0) + 1);
    tradeCounts.set(t.receiverTeam, (tradeCounts.get(t.receiverTeam) ?? 0) + 1);
  }
  const countSorted = [...tradeCounts.entries()]
    .map(([abbr, count]) => ({ abbr, name: teams[abbr]?.name ?? abbr, count }))
    .sort((a, b) => b.count - a.count);

  // Hit rate leaderboard
  const hitData = new Map<string, { accepted: number; total: number }>();
  const ensure = (abbr: string) => { if (!hitData.has(abbr)) hitData.set(abbr, { accepted: 0, total: 0 }); };
  for (const t of history) {
    ensure(t.proposerTeam);
    hitData.get(t.proposerTeam)!.accepted++;
    hitData.get(t.proposerTeam)!.total++;
    ensure(t.receiverTeam);
    hitData.get(t.receiverTeam)!.accepted++;
    hitData.get(t.receiverTeam)!.total++;
  }
  for (const t of cancelled) {
    ensure(t.proposerTeam);
    hitData.get(t.proposerTeam)!.total++;
    ensure(t.receiverTeam);
    hitData.get(t.receiverTeam)!.total++;
  }
  const hitSorted = [...hitData.entries()]
    .filter(([, d]) => d.total > 0)
    .map(([abbr, d]) => ({
      abbr,
      name: teams[abbr]?.name ?? abbr,
      rate: d.accepted / d.total,
      accepted: d.accepted,
      total: d.total,
      isCPU: !state.assignments[abbr],
    }))
    .sort((a, b) => b.rate - a.rate || b.accepted - a.accepted);

  const rankPrefix = (arr: Array<{ count?: number; rate?: number }>, i: number, key: 'count' | 'rate') => {
    let rank = 1;
    for (let j = 0; j < i; j++) {
      if ((arr[j] as any)[key] > (arr[i] as any)[key]) rank = j + 1;
    }
    // Find the actual rank (accounting for ties)
    if (i === 0) rank = 1;
    else if ((arr[i] as any)[key] < (arr[i - 1] as any)[key]) rank = i + 1;
    else rank = parseInt(rankPrefix(arr, i - 1, key)) || i + 1;
    return rank <= 3 ? medals[rank - 1] : `${rank}.`;
  };

  return (
    <div className="trade-leaderboards">
      {countSorted.length > 0 && (
        <div className="trade-section">
          <div className="section-header">Trade Leaderboard</div>
          <div className="leaderboard-list">
            {countSorted.map((entry, i) => {
              let rank = i + 1;
              if (i > 0 && entry.count === countSorted[i - 1].count) {
                // find the first index with this count
                let j = i - 1;
                while (j > 0 && countSorted[j - 1].count === entry.count) j--;
                rank = j + 1;
              }
              const prefix = rank <= 3 ? medals[rank - 1] : `${rank}.`;
              return (
                <div key={entry.abbr} className="leaderboard-row">
                  <span className="leaderboard-rank">{prefix}</span>
                  <span className="leaderboard-name">{entry.name}</span>
                  <span className="leaderboard-stat">{entry.count} trade{entry.count !== 1 ? 's' : ''}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {hitSorted.length > 0 && (
        <div className="trade-section">
          <div className="section-header">Trade Hit Rate</div>
          <div className="leaderboard-list">
            {hitSorted.map((entry, i) => {
              let rank = i + 1;
              if (i > 0 && entry.rate === hitSorted[i - 1].rate) {
                let j = i - 1;
                while (j > 0 && hitSorted[j - 1].rate === entry.rate) j--;
                rank = j + 1;
              }
              const prefix = rank <= 3 ? medals[rank - 1] : `${rank}.`;
              const pct = Math.round(entry.rate * 100);
              const tag = entry.isCPU ? ' (AI)' : '';
              return (
                <div key={entry.abbr} className="leaderboard-row">
                  <span className="leaderboard-rank">{prefix}</span>
                  <span className="leaderboard-name">{entry.name}{tag}</span>
                  <span className="leaderboard-stat">{pct}% ({entry.accepted}/{entry.total})</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function TradeCard({ trade, teams, myTeam, formatAssets, onAccept, onDecline }: {
  trade: PendingTrade;
  teams: Record<string, Team>;
  myTeam: string | null;
  formatAssets: (o: number[], p: string[], f: string[]) => string;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
}) {
  const t1 = teams[trade.proposerTeam]?.name ?? trade.proposerTeam;
  const t2 = teams[trade.receiverTeam]?.name ?? trade.receiverTeam;
  const canRespond = trade.receiverTeam === myTeam;

  return (
    <div className="trade-card">
      <div className="trade-card-header">
        <span className="trade-card-teams">{t1} ↔ {t2}</span>
        <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>
          {Math.round((trade.expiresAt - Date.now()) / 60000)}m left
        </span>
      </div>
      <div className="trade-card-details">
        {t1} offers: {formatAssets(trade.offeredOveralls, trade.offeredPlayers, trade.offeredFuturePicks)}
        <br />
        {t2} offers: {formatAssets(trade.requestedOveralls, trade.requestedPlayers, trade.requestedFuturePicks)}
      </div>
      {canRespond && (
        <div className="trade-card-actions">
          <button className="success" onClick={() => onAccept(trade.id)}>Accept</button>
          <button className="danger" onClick={() => onDecline(trade.id)}>Decline</button>
        </div>
      )}
    </div>
  );
}

function TradeProposalForm({ roomCode, state, teams, myTeam, onMsg }: {
  roomCode: string;
  state: DraftState;
  teams: Record<string, Team>;
  myTeam: string;
  onMsg: (msg: string) => void;
}) {
  const [targetTeam, setTargetTeam] = useState('');
  const [offeredPicks, setOfferedPicks] = useState<Set<number>>(new Set());
  const [requestedPicks, setRequestedPicks] = useState<Set<number>>(new Set());
  const [offeredPlayers, setOfferedPlayers] = useState<Set<string>>(new Set());
  const [requestedPlayers, setRequestedPlayers] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [myRoster, setMyRoster] = useState<Array<{ name: string; pos: string }>>([]);
  const [targetRoster, setTargetRoster] = useState<Array<{ name: string; pos: string }>>([]);
  const [showMyPlayers, setShowMyPlayers] = useState(false);
  const [showTargetPlayers, setShowTargetPlayers] = useState(false);

  // Fetch my roster on mount
  useEffect(() => {
    if (myTeam) {
      api.getInventory(roomCode, myTeam).then(d => {
        setMyRoster(d.roster ?? []);
      }).catch(() => {});
    }
  }, [roomCode, myTeam]);

  // Fetch target roster when target changes
  useEffect(() => {
    if (targetTeam) {
      api.getInventory(roomCode, targetTeam).then(d => {
        setTargetRoster(d.roster ?? []);
      }).catch(() => {});
    } else {
      setTargetRoster([]);
    }
  }, [roomCode, targetTeam]);

  // My picks still available
  const myPickSlots = state.schedule.filter(s =>
    s.currentTeam === myTeam && s.overall > state.currentPickIndex &&
    !state.picks.find(p => p.overall === s.overall)
  );

  // Target team's picks
  const targetPickSlots = targetTeam
    ? state.schedule.filter(s =>
        s.currentTeam === targetTeam && s.overall > state.currentPickIndex &&
        !state.picks.find(p => p.overall === s.overall)
      )
    : [];

  const otherTeams = Object.keys(teams).filter(a => a !== myTeam).sort((a, b) => teams[a].name.localeCompare(teams[b].name));

  const togglePick = (set: Set<number>, setFn: React.Dispatch<React.SetStateAction<Set<number>>>, overall: number) => {
    const next = new Set(set);
    if (next.has(overall)) next.delete(overall); else next.add(overall);
    setFn(next);
  };

  const togglePlayer = (set: Set<string>, setFn: React.Dispatch<React.SetStateAction<Set<string>>>, name: string) => {
    const next = new Set(set);
    if (next.has(name)) next.delete(name); else next.add(name);
    setFn(next);
  };

  const handlePropose = async () => {
    if (!targetTeam || (offeredPicks.size === 0 && requestedPicks.size === 0 && offeredPlayers.size === 0 && requestedPlayers.size === 0)) return;
    try {
      setLoading(true);
      await api.proposeTrade(roomCode, {
        receiverTeam: targetTeam,
        offeredOveralls: Array.from(offeredPicks),
        requestedOveralls: Array.from(requestedPicks),
        offeredPlayers: Array.from(offeredPlayers),
        requestedPlayers: Array.from(requestedPlayers),
      });
      onMsg('Trade proposed!');
      setOfferedPicks(new Set());
      setRequestedPicks(new Set());
      setOfferedPlayers(new Set());
      setRequestedPlayers(new Set());
    } catch (err: any) {
      onMsg(err.message);
    } finally {
      setLoading(false);
    }
  };

  const hasAssets = offeredPicks.size > 0 || requestedPicks.size > 0 || offeredPlayers.size > 0 || requestedPlayers.size > 0;

  return (
    <div className="trade-section">
      <div className="section-header">Propose Trade</div>
      <div className="trade-propose-form">
        <div>
          <label>Trade With</label>
          <select value={targetTeam} onChange={e => {
            setTargetTeam(e.target.value);
            setRequestedPicks(new Set());
            setRequestedPlayers(new Set());
          }}>
            <option value="">Select team...</option>
            {otherTeams.map(a => (
              <option key={a} value={a}>{teams[a].name}{state.assignments[a] ? '' : ' (CPU)'}</option>
            ))}
          </select>
        </div>

        {targetTeam && (
          <>
            {/* You Give - Picks */}
            <div>
              <label>You Give (picks)</label>
              <div className="pick-chips">
                {myPickSlots.map(s => (
                  <span
                    key={s.overall}
                    className={`pick-chip${offeredPicks.has(s.overall) ? ' selected' : ''}`}
                    onClick={() => togglePick(offeredPicks, setOfferedPicks, s.overall)}
                  >
                    #{s.overall} (R{s.round})
                  </span>
                ))}
                {myPickSlots.length === 0 && <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>No picks available</span>}
              </div>
            </div>

            {/* You Give - Players */}
            <div>
              <label style={{ cursor: 'pointer' }} onClick={() => setShowMyPlayers(!showMyPlayers)}>
                You Give (players) {offeredPlayers.size > 0 && `(${offeredPlayers.size})`} {showMyPlayers ? '▾' : '▸'}
              </label>
              {showMyPlayers && (
                <div className="pick-chips">
                  {myRoster.slice(0, 40).map(p => (
                    <span
                      key={p.name}
                      className={`pick-chip${offeredPlayers.has(p.name) ? ' selected' : ''}`}
                      onClick={() => togglePlayer(offeredPlayers, setOfferedPlayers, p.name)}
                    >
                      {p.name} ({p.pos})
                    </span>
                  ))}
                  {myRoster.length === 0 && <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>No roster loaded</span>}
                </div>
              )}
              {offeredPlayers.size > 0 && !showMyPlayers && (
                <div className="pick-chips" style={{ marginTop: 4 }}>
                  {Array.from(offeredPlayers).map(name => (
                    <span key={name} className="pick-chip selected" onClick={() => togglePlayer(offeredPlayers, setOfferedPlayers, name)}>
                      {name} ✕
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* You Get - Picks */}
            <div>
              <label>You Get (picks)</label>
              <div className="pick-chips">
                {targetPickSlots.map(s => (
                  <span
                    key={s.overall}
                    className={`pick-chip${requestedPicks.has(s.overall) ? ' selected' : ''}`}
                    onClick={() => togglePick(requestedPicks, setRequestedPicks, s.overall)}
                  >
                    #{s.overall} (R{s.round})
                  </span>
                ))}
                {targetPickSlots.length === 0 && <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>No picks available</span>}
              </div>
            </div>

            {/* You Get - Players */}
            <div>
              <label style={{ cursor: 'pointer' }} onClick={() => setShowTargetPlayers(!showTargetPlayers)}>
                You Get (players) {requestedPlayers.size > 0 && `(${requestedPlayers.size})`} {showTargetPlayers ? '▾' : '▸'}
              </label>
              {showTargetPlayers && (
                <div className="pick-chips">
                  {targetRoster.slice(0, 40).map(p => (
                    <span
                      key={p.name}
                      className={`pick-chip${requestedPlayers.has(p.name) ? ' selected' : ''}`}
                      onClick={() => togglePlayer(requestedPlayers, setRequestedPlayers, p.name)}
                    >
                      {p.name} ({p.pos})
                    </span>
                  ))}
                  {targetRoster.length === 0 && <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>No roster loaded</span>}
                </div>
              )}
              {requestedPlayers.size > 0 && !showTargetPlayers && (
                <div className="pick-chips" style={{ marginTop: 4 }}>
                  {Array.from(requestedPlayers).map(name => (
                    <span key={name} className="pick-chip selected" onClick={() => togglePlayer(requestedPlayers, setRequestedPlayers, name)}>
                      {name} ✕
                    </span>
                  ))}
                </div>
              )}
            </div>

            <button className="primary" onClick={handlePropose} disabled={loading || !hasAssets}>
              {loading ? 'Proposing...' : 'Propose Trade'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
