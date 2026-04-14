import React, { useState, useEffect } from 'react';
import * as api from '../api';

interface LeakPanelProps {
  roomCode: string;
}

interface InsiderInfo {
  name: string;
  handle: string;
  avatar: string;
}

interface LeakResult {
  name: string;
  handle: string;
  avatar: string;
  tweet: string;
}

export function LeakPanel({ roomCode }: LeakPanelProps) {
  const [insiders, setInsiders] = useState<InsiderInfo[]>([]);
  const [info, setInfo] = useState('');
  const [selectedInsider, setSelectedInsider] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LeakResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getInsiders(roomCode).then(d => setInsiders(d.insiders)).catch(() => {});
  }, [roomCode]);

  const handleSubmit = async () => {
    if (!info.trim() || loading) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const data = await api.submitLeak(roomCode, info.trim(), selectedInsider || undefined);
      setResult(data);
      setInfo('');
    } catch (err: any) {
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      setError(isTimeout ? 'Request timed out — check InsiderX feed, it may have gone through.' : (err.message || 'Leak failed.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="leak-panel">
      <div className="leak-form">
        <label className="leak-label">Leak intel to an insider</label>
        <textarea
          className="leak-input"
          value={info}
          onChange={e => setInfo(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
          placeholder={'Drop a tip... e.g.\n"The Bears are desperate to trade up"\n"Cowboys are taking a QB, I\'m hearing it from everyone"'}
          rows={3}
          disabled={loading}
        />
        <div className="leak-controls">
          <select
            className="leak-select"
            value={selectedInsider}
            onChange={e => setSelectedInsider(e.target.value)}
            disabled={loading}
          >
            <option value="">Random insider</option>
            {insiders.map(i => (
              <option key={i.name} value={i.name}>{i.name} ({i.handle})</option>
            ))}
          </select>
          <button
            className="primary"
            onClick={handleSubmit}
            disabled={loading || !info.trim()}
          >
            {loading ? 'Leaking...' : 'Leak'}
          </button>
        </div>
      </div>

      {error && <div className="leak-error">{error}</div>}

      {result && (
        <div className="leak-result">
          <div className="leak-tweet">
            <div className="leak-tweet-header">
              <img className="leak-avatar" src={result.avatar} alt="" />
              <div className="leak-tweet-author">
                <span className="leak-tweet-name">{result.name}</span>
                <span className="leak-tweet-handle">{result.handle}</span>
              </div>
            </div>
            <div className="leak-tweet-body">{result.tweet}</div>
          </div>
          <div className="leak-sent-note">Sent to InsiderX feed</div>
        </div>
      )}
    </div>
  );
}
