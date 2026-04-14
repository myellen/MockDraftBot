import React, { useState, useRef, useEffect } from 'react';
import * as api from '../api';
import { Markdown } from './Markdown';
import type { DraftState, Team } from '../types';

interface BoardAIChatProps {
  roomCode: string;
  state: DraftState;
  teams: Record<string, Team>;
  userId: string;
  onBoardChanged?: () => void;
}

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  action?: string;
  boardResult?: any;
}

let msgId = 0;

export function BoardAIChat({ roomCode, state, teams, userId, onBoardChanged }: BoardAIChatProps) {
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
      const data = await api.boardAI(roomCode, text);
      const resp = data.response;

      let reply = '';
      let action = resp.action;

      if (resp.error) {
        reply = resp.error;
        action = undefined;
      } else if (resp.action === 'answer_question') {
        reply = resp.answer || resp.explanation || 'No answer returned.';
      } else if (resp.action === 'submit_board') {
        const br = data.boardResult;
        reply = resp.explanation || 'Board updated.';
        if (br) {
          reply += `\n\nMatched ${br.matched} prospects.`;
          if (br.unmatched?.length > 0) reply += ` Unmatched: ${br.unmatched.join(', ')}`;
        }
      } else if (resp.action === 'set_strategy') {
        reply = `Strategy set: ${resp.strategyPrompt}`;
        if (resp.explanation) reply += `\n\n${resp.explanation}`;
      } else if (resp.action === 'clear') {
        reply = `Cleared ${resp.clearWhat ?? 'all'}.`;
        if (resp.explanation) reply += ` ${resp.explanation}`;
      }

      setMessages(prev => [...prev, {
        id: ++msgId,
        role: 'assistant',
        content: reply,
        action,
        boardResult: data.boardResult,
      }]);

      // Notify parent that board/strategy changed so other tabs refresh
      if (action && action !== 'answer_question') {
        onBoardChanged?.();
      }
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
    await api.clearAIHistory(roomCode, 'board').catch(() => {});
    setMessages([]);
  };

  if (!myTeam) {
    return (
      <div className="not-your-turn" style={{ padding: 20 }}>
        <p>Register for a team first to use Board AI.</p>
      </div>
    );
  }

  return (
    <div className="ai-chat">
      <div className="ai-chat-header">
        <span>Scout AI</span>
        {messages.length > 0 && (
          <button onClick={handleClearHistory} style={{ fontSize: '0.6rem', padding: '2px 6px' }}>Clear</button>
        )}
      </div>
      <div className="ai-chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="ai-chat-hint">
            Ask about prospects, manage your board, or set a draft strategy.
            <br /><br />
            <em>"Who are the best EDGE rushers?"</em>
            <br />
            <em>"Prioritize QBs and WRs on my board"</em>
            <br />
            <em>"Draft for need — fill my roster holes"</em>
            <br />
            <em>"Set my strategy to value athletic upside"</em>
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`ai-chat-msg ${m.role}`}>
            <div className="ai-chat-msg-label">{m.role === 'user' ? 'You' : 'Scout'}</div>
            <div className="ai-chat-msg-text">
              {m.role === 'assistant' ? <Markdown content={m.content} /> : m.content}
            </div>
            {m.action && m.action !== 'answer_question' && (
              <div style={{ fontSize: '0.65rem', color: 'var(--accent-info)', marginTop: 4, fontFamily: 'var(--font-heading)', textTransform: 'uppercase' }}>
                {m.action === 'submit_board' ? 'Board updated' : m.action === 'set_strategy' ? 'Strategy saved' : 'Action completed'}
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="ai-chat-msg assistant">
            <div className="ai-chat-msg-label">Scout</div>
            <div className="ai-chat-msg-text ai-thinking">Analyzing scouting data...</div>
          </div>
        )}
      </div>
      <div className="ai-chat-input">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder="Ask about prospects or manage your board..."
          disabled={loading}
        />
        <button className="primary" onClick={handleSend} disabled={loading || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
