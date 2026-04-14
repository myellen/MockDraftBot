import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../api';
import * as ws from '../ws';
import { Header } from './Header';
import { DraftBoard } from './DraftBoard';
import { CommandCenter } from './CommandCenter';
import { SocialFeed } from './SocialFeed';
import type { DraftState, Team, FeedItem, CompletedPick, PendingTrade, InsiderTweet, CPUOffer } from '../types';
import '../styles/room.css';

interface DraftRoomProps {
  roomCode: string;
  token: string;
  isAdmin: boolean;
  onLeave: () => void;
}

let feedIdCounter = 0;
function nextFeedId(): string {
  return `feed-${++feedIdCounter}-${Date.now()}`;
}

export function DraftRoom({ roomCode, token, isAdmin, onLeave }: DraftRoomProps) {
  const [state, setState] = useState<DraftState | null>(null);
  const [teams, setTeams] = useState<Record<string, Team>>({});
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [cpuOffers, setCpuOffers] = useState<CPUOffer[]>([]);
  const [tradeResults, setTradeResults] = useState<Array<{ trade: PendingTrade; accepted: boolean; reasoning?: string }>>([]);
  const [userId, setUserId] = useState('');
  const lastRoundRef = useRef(0);

  // Parse userId from token
  useEffect(() => {
    try {
      const payload = api.decodeTokenPayload(token);
      setUserId(payload?.userId ?? '');
    } catch { /* ignore */ }
  }, [token]);

  const addFeedItem = useCallback((type: FeedItem['type'], data: any) => {
    setFeedItems(prev => [{
      id: nextFeedId(),
      type,
      timestamp: Date.now(),
      data,
    }, ...prev].slice(0, 200)); // Keep max 200 items
  }, []);

  // Fetch initial state + connect WebSocket
  useEffect(() => {
    api.getState(roomCode).then(d => {
      setState(d.state);
      setTeams(d.teams);
      // Restore persisted feed items
      if (d.state?.feedItems?.length) {
        setFeedItems(d.state.feedItems as FeedItem[]);
      }
      if (d.state?.schedule) {
        const slot = d.state.schedule[d.state.currentPickIndex];
        if (slot) lastRoundRef.current = slot.round;
      }
    });

    ws.connect(roomCode, token);

    const unsubs = [
      ws.on('state:snapshot', (data) => {
        setState(data as DraftState);
      }),
      ws.on('pick:made', (data: { pick: CompletedPick }) => {
        setState(prev => prev ? { ...prev } : prev);
        addFeedItem('pick-made', data.pick);
        // Re-fetch full state for consistency
        api.getState(roomCode).then(d => {
          setState(d.state);
          // Check for round change
          const slot = d.state?.schedule?.[d.state?.currentPickIndex ?? 0];
          if (slot && slot.round !== lastRoundRef.current) {
            addFeedItem('round-change', { round: slot.round });
            lastRoundRef.current = slot.round;
          }
        });
      }),
      ws.on('pick:clock', () => {
        api.getState(roomCode).then(d => setState(d.state));
      }),
      ws.on('draft:started', () => {
        api.getState(roomCode).then(d => setState(d.state));
        addFeedItem('round-change', { round: 1 });
        lastRoundRef.current = 1;
      }),
      ws.on('draft:paused', () => {
        api.getState(roomCode).then(d => setState(d.state));
      }),
      ws.on('draft:resumed', () => {
        api.getState(roomCode).then(d => setState(d.state));
      }),
      ws.on('draft:complete', () => {
        api.getState(roomCode).then(d => setState(d.state));
      }),
      ws.on('draft:reset', () => {
        api.getState(roomCode).then(d => setState(d.state));
        setFeedItems([]);
        setCpuOffers([]);
        setTradeResults([]);
      }),
      ws.on('trade:executed', (data: { trade: PendingTrade }) => {
        api.getState(roomCode).then(d => setState(d.state));
        addFeedItem('trade-executed', data.trade);
        // Track accepted result for trades we proposed
        setTradeResults(prev => [{ trade: data.trade, accepted: true }, ...prev]);
      }),
      ws.on('trade:cancelled', (data: { trade: PendingTrade; reason: string; reasoning?: string }) => {
        api.getState(roomCode).then(d => setState(d.state));
        addFeedItem('trade-cancelled', data);
        // Track declined result for trades we proposed
        if (data.reasoning) {
          setTradeResults(prev => [{ trade: data.trade, accepted: false, reasoning: data.reasoning }, ...prev]);
        }
      }),
      ws.on('trade:chatter', (data) => {
        addFeedItem('trade-chatter', data);
      }),
      ws.on('cpu-offer:sent', (data) => {
        api.getState(roomCode).then(d => setState(d.state));
        setCpuOffers(prev => [data.offer as CPUOffer, ...prev]);
        addFeedItem('cpu-offer', data.offer);
      }),
      ws.on('cpu-offer:resolved', (data) => {
        api.getState(roomCode).then(d => setState(d.state));
        const resolved = data as { offerId?: string };
        if (resolved.offerId) {
          setCpuOffers(prev => prev.filter(o => o.id !== resolved.offerId));
        }
      }),
      ws.on('insider:tweet', (data: InsiderTweet) => {
        addFeedItem('insider-tweet', data);
      }),
    ];

    return () => {
      unsubs.forEach(fn => fn());
      ws.disconnect();
    };
  }, [roomCode, token, addFeedItem]);

  return (
    <div className="draft-room">
      <Header
        roomCode={roomCode}
        state={state}
        teams={teams}
        isAdmin={isAdmin}
        onLeave={onLeave}
      />
      <div className="draft-room-body">
        <DraftBoard state={state} teams={teams} />
        <CommandCenter
          roomCode={roomCode}
          state={state}
          teams={teams}
          isAdmin={isAdmin}
          userId={userId}
          cpuOffers={cpuOffers}
          onCpuOfferResolved={(id) => setCpuOffers(prev => prev.filter(o => o.id !== id))}
          tradeResults={tradeResults}
          onDismissResult={(idx) => setTradeResults(prev => prev.filter((_, i) => i !== idx))}
        />
        <SocialFeed items={feedItems} teams={teams} />
      </div>
    </div>
  );
}
