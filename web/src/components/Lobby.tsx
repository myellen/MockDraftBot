import React, { useState, useEffect } from 'react';
import * as api from '../api';
import '../styles/lobby.css';

interface LobbyProps {
  onEnterRoom: (code: string, token: string, isAdmin: boolean) => void;
}

interface StoredSession {
  roomCode: string;
  admin: boolean;
  displayName: string;
  token: string;
}

function getStoredSession(): StoredSession | null {
  const token = api.getToken();
  if (!token) return null;
  try {
    const payload = api.decodeTokenPayload(token);
    if (!payload?.roomCode || !payload?.exp) return null;
    if (payload.exp < Date.now()) { api.clearToken(); return null; }
    return { roomCode: payload.roomCode, admin: payload.admin ?? false, displayName: payload.displayName ?? 'User', token };
  } catch { return null; }
}

export function Lobby({ onEnterRoom }: LobbyProps) {
  const [joinCode, setJoinCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [createdCode, setCreatedCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [stored, setStored] = useState<StoredSession | null>(null);

  useEffect(() => { setStored(getStoredSession()); }, []);

  const handleCreate = async () => {
    try {
      setError('');
      setLoading(true);
      const { roomCode, token } = await api.createRoom();
      api.setToken(token);
      setCreatedCode(roomCode);
      // Auto-enter after a moment so user can see the code
      setTimeout(() => onEnterRoom(roomCode, token, true), 1500);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleJoin = async () => {
    if (!joinCode || !displayName) {
      setError('Enter a room code and your name.');
      return;
    }
    try {
      setError('');
      setLoading(true);
      const { token } = await api.joinRoom(joinCode, displayName);
      api.setToken(token);
      // Parse admin flag from token
      let isAdmin = false;
      try {
        const payload = api.decodeTokenPayload(token);
        isAdmin = payload?.admin ?? false;
      } catch { /* ignore */ }
      onEnterRoom(joinCode, token, isAdmin);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRejoin = () => {
    if (!stored) return;
    api.setToken(stored.token);
    onEnterRoom(stored.roomCode, stored.token, stored.admin);
  };

  const handleDismissRejoin = () => {
    api.clearToken();
    setStored(null);
  };

  const copyCode = () => {
    navigator.clipboard.writeText(createdCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="lobby">
      <div className="lobby-content">
        <h1 className="lobby-title">NFL MOCK DRAFT</h1>
        <div className="lobby-accent-line" />
        <p className="lobby-subtitle">War Room Experience</p>

        {createdCode ? (
          <div style={{ textAlign: 'center' }}>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 12, fontFamily: 'var(--font-heading)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '0.8rem' }}>
              Room Created
            </p>
            <div className="room-code-display" onClick={copyCode}>
              {createdCode}
              <span className="copy-hint">{copied ? 'Copied!' : 'Click to copy'}</span>
            </div>
            <p style={{ color: 'var(--text-dim)', fontSize: '0.8rem', marginTop: 8 }}>
              Entering room...
            </p>
          </div>
        ) : (
          <>
            {/* Rejoin banner */}
            {stored && (
              <div className="rejoin-banner">
                <div className="rejoin-info">
                  <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)' }}>
                    Active Session
                  </span>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', color: 'var(--text-primary)' }}>
                    Room {stored.roomCode}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                    {stored.admin ? 'Admin' : stored.displayName}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="primary" onClick={handleRejoin}>Rejoin</button>
                  <button onClick={handleDismissRejoin} style={{ fontSize: '0.7rem', padding: '4px 10px' }}>Dismiss</button>
                </div>
              </div>
            )}

            <div className="lobby-cards">
              <div className="lobby-card">
                <h3>Create Room</h3>
                <button className="primary" onClick={handleCreate} disabled={loading}>
                  {loading ? 'Creating...' : 'New Draft Room'}
                </button>
              </div>

              <div className="lobby-card">
                <h3>Join Room</h3>
                <input
                  placeholder="Room Code"
                  value={joinCode}
                  onChange={e => setJoinCode(e.target.value.toUpperCase())}
                  onKeyDown={e => e.key === 'Enter' && handleJoin()}
                />
                <input
                  placeholder="Your Name"
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleJoin()}
                />
                <button className="primary" onClick={handleJoin} disabled={loading}>
                  {loading ? 'Joining...' : 'Join'}
                </button>
              </div>
            </div>
          </>
        )}

        {error && <div className="lobby-error">{error}</div>}
      </div>
    </div>
  );
}
