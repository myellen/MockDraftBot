import React, { useState, useRef, useEffect } from 'react';
import * as api from '../api';
import { Markdown } from './Markdown';
import type { DraftState, Team } from '../types';

interface TradeAIChatProps {
  roomCode: string;
  state: DraftState;
  teams: Record<string, Team>;
  userId: string;
}

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  tradeProposed?: boolean;
}

let msgId = 0;

export function TradeAIChat({ roomCode, state, teams, userId }: TradeAIChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const myTeam = Object.entries(state.assignments).find(([, uid]) => uid === userId)?.[0]
    ?? Object.entries(state.coManagers).find(([, uids]) => uids.includes(userId))?.[0]
    ?? null;

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: ChatMessage = { id: ++msgId, role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const data = await api.tradeAI(roomCode, text);
      const resp = data.response;

      let reply = '';
      if (resp.error) {
        reply = resp.error;
      } else if (resp.clarification) {
        reply = resp.clarification;
      } else {
        const targetName = teams[resp.targetTeam]?.name ?? resp.targetTeam;
        const myTeamName = myTeam ? (teams[myTeam]?.name ?? myTeam) : 'You';

        const fmtSide = (picks: number[], players: string[], futures: string[]) => {
          const parts: string[] = [];
          if (picks?.length) parts.push(picks.map((o: number) => `Pick #${o}`).join(', '));
          if (players?.length) parts.push(players.join(', '));
          if (futures?.length) parts.push(futures.join(', '));
          return parts.join(' + ') || '(nothing)';
        };

        reply = `**${myTeamName}** send: ${fmtSide(resp.offeredPicks, resp.offeredPlayers, resp.offeredFuturePicks)}\n` +
          `**${targetName}** send: ${fmtSide(resp.requestedPicks, resp.requestedPlayers, resp.requestedFuturePicks)}`;

        if (resp.explanation) reply += `\n\n> ${resp.explanation}`;

        if (data.tradeResult) {
          if (data.tradeResult.success) {
            reply += '\n\nTrade proposal sent!';
          } else {
            reply += `\n\nTrade failed: ${data.tradeResult.error}`;
          }
        }
      }

      setMessages(prev => [...prev, {
        id: ++msgId,
        role: 'assistant',
        content: reply,
        tradeProposed: !!data.tradeResult?.success,
      }]);
    } catch (err: any) {
      setMessages(prev => [...prev, {
        id: ++msgId,
        role: 'assistant',
        content: `Error: ${err.message}`,
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleClearHistory = async () => {
    await api.clearAIHistory(roomCode, 'trade').catch(() => {});
    setMessages([]);
  };

  if (!myTeam) {
    return (
      <div className="not-your-turn" style={{ padding: 20 }}>
        <p>Register for a team first to use Trade AI.</p>
      </div>
    );
  }

  return (
    <div className="ai-chat">
      <div className="ai-chat-header">
        <span>Trade AI</span>
        {messages.length > 0 && (
          <button onClick={handleClearHistory} style={{ fontSize: '0.6rem', padding: '2px 6px' }}>Clear</button>
        )}
      </div>
      <div className="ai-chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="ai-chat-hint">
            Describe a trade in plain English.
            <br /><br />
            <em>"Trade my 1st round pick to the Cowboys for their 2nd and 4th"</em>
            <br />
            <em>"Swap late round picks with MIN"</em>
            <br />
            <em>"Send Patrick Mahomes to NYJ for their next two firsts"</em>
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`ai-chat-msg ${m.role}`}>
            <div className="ai-chat-msg-label">{m.role === 'user' ? 'You' : 'AI'}</div>
            <div className="ai-chat-msg-text">
              {m.role === 'assistant' ? <Markdown content={m.content} /> : m.content}
            </div>
            {m.tradeProposed && (
              <div style={{ fontSize: '0.7rem', color: 'var(--accent-trade)', marginTop: 4 }}>
                Trade proposal sent to the Trades tab
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="ai-chat-msg assistant">
            <div className="ai-chat-msg-label">AI</div>
            <div className="ai-chat-msg-text ai-thinking">Thinking...</div>
          </div>
        )}
      </div>
      <div className="ai-chat-input">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder="Describe a trade..."
          disabled={loading}
        />
        <button className="primary" onClick={handleSend} disabled={loading || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
