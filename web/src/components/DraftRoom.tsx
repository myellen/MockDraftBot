import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../api';
import * as ws from '../ws';
import { Header } from './Header';
import { DraftBoard } from './DraftBoard';
import { CommandCenter } from './CommandCenter';
import { SocialFeed } from './SocialFeed';
import { setDraftMode } from '../mode';
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
      setDraftMode(d.mode);
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
        addFeedItem('pick-made', data.pick);
      }),
      ws.on('pick:clock', (_data) => {
        // State arrives via state:snapshot — check for round change
        setState(prev => {
          if (!prev) return prev;
          const slot = prev.schedule?.[prev.currentPickIndex];
          if (slot && slot.round !== lastRoundRef.current) {
            addFeedItem('round-change', { round: slot.round });
            lastRoundRef.current = slot.round;
          }
          return prev;
        });
      }),
      ws.on('draft:started', () => {
        addFeedItem('round-change', { round: 1 });
        lastRoundRef.current = 1;
      }),
      ws.on('draft:paused', () => {}),
      ws.on('draft:resumed', () => {}),
      ws.on('draft:complete', () => {}),
      ws.on('draft:reset', () => {
        setFeedItems([]);
        setCpuOffers([]);
        setTradeResults([]);
      }),
      ws.on('trade:executed', (data: { trade: PendingTrade }) => {
        addFeedItem('trade-executed', data.trade);
        setTradeResults(prev => [{ trade: data.trade, accepted: true }, ...prev]);
        api.getState(roomCode).then(d => setState(d.state));
      }),
      ws.on('trade:cancelled', (data: { trade: PendingTrade; reason: string; reasoning?: string }) => {
        addFeedItem('trade-cancelled', data);
        if (data.reasoning) {
          setTradeResults(prev => [{ trade: data.trade, accepted: false, reasoning: data.reasoning }, ...prev]);
        }
        api.getState(roomCode).then(d => setState(d.state));
      }),
      ws.on('trade:chatter', (data) => {
        addFeedItem('trade-chatter', data);
      }),
      ws.on('cpu-offer:sent', (data) => {
        setCpuOffers(prev => [data.offer as CPUOffer, ...prev]);
        addFeedItem('cpu-offer', data.offer);
        api.getState(roomCode).then(d => setState(d.state));
      }),
      ws.on('cpu-offer:resolved', (data) => {
        const resolved = data as { offerId?: string };
        if (resolved.offerId) {
          setCpuOffers(prev => prev.filter(o => o.id !== resolved.offerId));
        }
        api.getState(roomCode).then(d => setState(d.state));
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
