import React, { useState, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import './styles/global.css';
import { Lobby } from './components/Lobby';
import { DraftRoom } from './components/DraftRoom';
import * as api from './api';

function App() {
  const [screen, setScreen] = useState<'lobby' | 'room'>('lobby');
  const [roomCode, setRoomCode] = useState('');
  const [token, setToken] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

  // Auto-reconnect from stored token on mount
  useEffect(() => {
    const stored = api.getToken();
    if (!stored) return;
    try {
      const payload = api.decodeTokenPayload(stored);
      if (!payload?.roomCode || !payload?.exp) return;
      if (payload.exp < Date.now()) { api.clearToken(); return; }
      // Validate room still exists
      api.getState(payload.roomCode).then(() => {
        setRoomCode(payload.roomCode);
        setToken(stored);
        setIsAdmin(payload.admin ?? false);
        setScreen('room');
      }).catch(() => {
        api.clearToken();
      });
    } catch { api.clearToken(); }
  }, []);

  const handleEnterRoom = useCallback((code: string, tok: string, admin: boolean) => {
    setRoomCode(code);
    setToken(tok);
    setIsAdmin(admin);
    setScreen('room');
  }, []);

  const handleLeaveRoom = useCallback(() => {
    api.clearToken();
    setScreen('lobby');
    setRoomCode('');
    setToken('');
    setIsAdmin(false);
  }, []);

  if (screen === 'lobby') {
    return <Lobby onEnterRoom={handleEnterRoom} />;
  }

  return (
    <DraftRoom
      roomCode={roomCode}
      token={token}
      isAdmin={isAdmin}
      onLeave={handleLeaveRoom}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
