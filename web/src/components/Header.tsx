import React, { useState } from 'react';
import { Timer } from './Timer';
import * as api from '../api';
import type { DraftState, Team } from '../types';
import '../styles/header.css';

interface HeaderProps {
  roomCode: string;
  state: DraftState | null;
  teams: Record<string, Team>;
  isAdmin: boolean;
  onLeave: () => void;
}

export function Header({ roomCode, state, teams, isAdmin, onLeave }: HeaderProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const status = state?.status ?? 'idle';
  const slot = state?.schedule?.[state?.currentPickIndex ?? 0];
  const currentTeam = slot?.currentTeam;
  const teamName = currentTeam ? teams[currentTeam]?.name ?? currentTeam : null;

  const copyCode = () => {
    navigator.clipboard.writeText(roomCode);
  };

  const handleStart = async () => {
    try {
      setLoading(true);
      setError('');
      await api.startDraft(roomCode);
    } catch (err: any) {
      // Ignore fetch timeouts — start fires async, state comes via WebSocket
      if (!err.message?.includes('fetch')) setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePause = async () => {
    try { setError(''); await api.pauseDraft(roomCode); }
    catch (err: any) { setError(err.message); }
  };

  const handleResume = async () => {
    try { setError(''); await api.resumeDraft(roomCode); }
    catch (err: any) { setError(err.message); }
  };

  const handleReset = async () => {
    try { setError(''); await api.resetDraft(roomCode); }
    catch (err: any) { setError(err.message); }
  };

  return (
    <header className="draft-header">
      <div className="draft-header-left">
        <span className="draft-header-title">DRAFT</span>
        <span className="draft-header-code" onClick={copyCode} title="Click to copy">
          {roomCode}
        </span>
        <span className={`badge ${status}`}>
          {status === 'active' ? 'LIVE' : status.toUpperCase()}
        </span>

        {/* Admin controls inline with status */}
        {isAdmin && (
          <div className="header-admin-controls">
            {status === 'idle' && (
              <button className="header-ctrl-btn start" onClick={handleStart} disabled={loading}>
                {loading ? '...' : 'Start'}
              </button>
            )}
            {status === 'active' && (
              <button className="header-ctrl-btn" onClick={handlePause}>Pause</button>
            )}
            {status === 'paused' && (
              <button className="header-ctrl-btn start" onClick={handleResume}>Resume</button>
            )}
            {(status === 'paused' || status === 'complete') && (
              <button className="header-ctrl-btn danger" onClick={handleReset}>Reset</button>
            )}
          </div>
        )}

        {error && (
          <span style={{ fontSize: '0.7rem', color: 'var(--accent-breaking)', marginLeft: 8 }}>{error}</span>
        )}
      </div>

      <div className="draft-header-center">
        {(status === 'active' || status === 'paused') && slot && (
          <>
            <div className="on-clock-banner">
              <span className="display-text">{status === 'paused' ? 'PAUSED' : 'ON THE CLOCK'}</span>
            </div>
            <span className="draft-header-pick-info">
              RD {slot.round} PK {slot.roundPick} (#{slot.overall}) —{' '}
              <span className="team-name">{teamName}</span>
            </span>
            {status === 'active' && (
              <Timer
                expiresAt={state?.timerExpiresAt ?? null}
                timerSeconds={state?.config.timerSeconds ?? null}
              />
            )}
          </>
        )}
        {status === 'complete' && (
          <span className="draft-header-pick-info">DRAFT COMPLETE — {state?.picks.length} PICKS</span>
        )}
      </div>

      <div className="draft-header-right">
        <button className="header-leave-btn" onClick={onLeave}>Leave</button>
      </div>
    </header>
  );
}
