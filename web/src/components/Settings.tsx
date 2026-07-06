import React, { useState, useEffect, useCallback } from 'react';
import * as api from '../api';
import type { DraftState, DraftConfig, TradeAnnouncement } from '../types';

interface SettingsProps {
  roomCode: string;
  state: DraftState;
  isAdmin: boolean;
}

const TIMER_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: 'Off', value: null },
  { label: '30s', value: 30 },
  { label: '60s', value: 60 },
  { label: '120s', value: 120 },
  { label: '300s', value: 300 },
];

const ANNOUNCEMENT_OPTIONS: Array<{ label: string; value: TradeAnnouncement }> = [
  { label: 'Private', value: 'private' },
  { label: 'Public', value: 'public' },
  { label: 'Intrigue', value: 'intrigue' },
  { label: 'Insider', value: 'insider' },
];

export function Settings({ roomCode, state, isAdmin }: SettingsProps) {
  const config = state.config;
  const [local, setLocal] = useState<Partial<DraftConfig>>({});
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const merged = { ...config, ...local };

  const setField = <K extends keyof DraftConfig>(key: K, value: DraftConfig[K]) => {
    setLocal(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    try {
      setLoading(true);
      await api.setup(roomCode, local);
      setLocal({});
      setMsg('Settings saved!');
    } catch (err: any) { setMsg(err.message); }
    finally { setLoading(false); }
  };

  if (!isAdmin) {
    return (
      <div className="not-your-turn" style={{ padding: 20 }}>
        <p>Admin access required to change settings.</p>
      </div>
    );
  }

  const isDirty = Object.keys(local).length > 0;

  return (
    <div>
      <div className="section-header">Draft Settings</div>
      <div className="settings-grid">
        {/* Timer */}
        <div className="setting-row">
          <div className="setting-label">
            Pick Timer
            <small>Auto-pick when time expires</small>
          </div>
          <select
            value={merged.timerSeconds ?? ''}
            onChange={e => setField('timerSeconds', e.target.value ? Number(e.target.value) : null)}
            style={{ width: 100 }}
          >
            {TIMER_OPTIONS.map(o => (
              <option key={o.label} value={o.value ?? ''}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* Auto-pick */}
        <div className="setting-row">
          <div className="setting-label">
            Auto-Pick
            <small>CPU picks for unassigned teams</small>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={merged.autoPick} onChange={e => setField('autoPick', e.target.checked)} />
            <span className="toggle-slider" />
          </label>
        </div>

        {/* Rounds */}
        <div className="setting-row">
          <div className="setting-label">
            Rounds
            <small>Number of draft rounds</small>
          </div>
          <select
            value={merged.rounds}
            onChange={e => setField('rounds', Number(e.target.value))}
            style={{ width: 70 }}
          >
            {[1, 2, 3, 4, 5, 6, 7].map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>

        {/* CPU Trading */}
        <div className="setting-row">
          <div className="setting-label">
            CPU Trading
            <small>AI teams propose and evaluate trades</small>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={merged.cpuTrading} onChange={e => setField('cpuTrading', e.target.checked)} />
            <span className="toggle-slider" />
          </label>
        </div>

        {/* Simulation Mode */}
        <div className="setting-row">
          <div className="setting-label">
            Simulation Mode
            <small>No timeouts — every AI prompt runs to completion</small>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={merged.simulationMode} onChange={e => setField('simulationMode', e.target.checked)} />
            <span className="toggle-slider" />
          </label>
        </div>

        {/* GM Extra Research */}
        <div className="setting-row">
          <div className="setting-label">
            GM Extra Research
            <small>AI GMs research prospects before picking (requires Simulation Mode)</small>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={merged.gmExtraResearch} onChange={e => setField('gmExtraResearch', e.target.checked)} disabled={!merged.simulationMode} />
            <span className="toggle-slider" />
          </label>
        </div>

        {/* Trade Announcement */}
        <div className="setting-row">
          <div className="setting-label">
            Trade Announcements
            <small>How trades are announced</small>
          </div>
          <select
            value={merged.tradeAnnouncement}
            onChange={e => setField('tradeAnnouncement', e.target.value as TradeAnnouncement)}
            style={{ width: 110 }}
          >
            {ANNOUNCEMENT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* Salary Cap */}
        <div className="setting-row">
          <div className="setting-label">
            Salary Cap
            <small>Enforce salary cap on trades</small>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={merged.enforceSalaryCap} onChange={e => setField('enforceSalaryCap', e.target.checked)} />
            <span className="toggle-slider" />
          </label>
        </div>

        {/* Player Trades */}
        <div className="setting-row">
          <div className="setting-label">
            Player Trades
            <small>Allow trading rostered players</small>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={merged.allowPlayerTrades} onChange={e => setField('allowPlayerTrades', e.target.checked)} />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      {isDirty && (
        <div style={{ marginTop: 16 }}>
          <button className="primary" onClick={handleSave} disabled={loading} style={{ width: '100%' }}>
            {loading ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      )}

      {msg && <div className={`status-msg ${msg.includes('!') ? 'success' : 'error'}`} style={{ marginTop: 8 }}>{msg}</div>}

      <LLMQueueMonitor />
    </div>
  );
}

// ── LLM Queue Monitor ───────────────────────────────────────────────────────

function LLMQueueMonitor() {
  const [stats, setStats] = useState<{ active: number; queued: number; queuedLow: number } | null>(null);

  const poll = useCallback(() => {
    api.getLLMQueue().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [poll]);

  if (!stats) return null;

  const total = stats.active + stats.queued + stats.queuedLow;
  const maxSlots = 8; // visual slots to render

  return (
    <div style={{ marginTop: 24, padding: 12, background: 'var(--bg-deep)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
      <div className="section-header" style={{ marginBottom: 8, fontSize: '0.7rem' }}>LLM Queue</div>
      <div style={{ display: 'flex', gap: 3, marginBottom: 8 }}>
        {Array.from({ length: maxSlots }, (_, i) => {
          let color = 'var(--bg-card)';
          let label = '';
          if (i < stats.active) {
            color = 'var(--accent-green)';
            label = 'active';
          } else if (i < stats.active + stats.queued) {
            color = 'var(--accent-warning, #f59e0b)';
            label = 'queued';
          } else if (i < total) {
            color = 'var(--text-dim)';
            label = 'low';
          }
          return (
            <div
              key={i}
              title={label}
              style={{
                flex: 1,
                height: 6,
                borderRadius: 2,
                background: color,
                transition: 'background 0.3s',
              }}
            />
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 12, fontSize: '0.65rem', color: 'var(--text-dim)' }}>
        <span><span style={{ color: 'var(--accent-green)' }}>{stats.active}</span> active</span>
        <span><span style={{ color: 'var(--accent-warning, #f59e0b)' }}>{stats.queued}</span> queued</span>
        <span><span style={{ color: 'var(--text-secondary)' }}>{stats.queuedLow}</span> low-pri</span>
      </div>
    </div>
  );
}
