import React from 'react';
import type { FeedItem, Team } from '../types';
import { teamColorToCSS } from '../types';

interface TweetCardProps {
  item: FeedItem;
  teams: Record<string, Team>;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

// Random insider names for non-LLM generated feed items
const FEED_INSIDERS = [
  { name: 'NFL Draft Wire', handle: '@NFLDraftWire' },
  { name: 'Draft Tracker', handle: '@DraftTracker' },
  { name: 'League Sources', handle: '@LeagueSources' },
];

function randomFeedInsider() {
  return FEED_INSIDERS[Math.floor(Math.random() * FEED_INSIDERS.length)];
}

export function TweetCard({ item, teams }: TweetCardProps) {
  if (item.type === 'round-change') {
    return (
      <div className="feed-milestone">
        <span className="feed-milestone-text">ROUND {item.data.round} IS UNDERWAY</span>
      </div>
    );
  }

  if (item.type === 'insider-tweet') {
    const d = item.data;
    return (
      <div className="tweet-card insider">
        {d.avatar ? (
          <img className="tweet-avatar" src={d.avatar} alt="" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        ) : (
          <div className="tweet-avatar-placeholder">X</div>
        )}
        <div className="tweet-body">
          <div className="tweet-header">
            <span className="tweet-name">{d.name}</span>
            <span className="tweet-handle">{d.handle}</span>
            <span className="tweet-time">{timeAgo(item.timestamp)}</span>
          </div>
          <div className="tweet-text">{d.tweet}</div>
        </div>
      </div>
    );
  }

  if (item.type === 'trade-executed') {
    const t = item.data;
    const t1 = teams[t.proposerTeam]?.name ?? t.proposerTeam;
    const t2 = teams[t.receiverTeam]?.name ?? t.receiverTeam;
    const gives = [...(t.offeredOveralls ?? []).map((o: number) => `#${o}`), ...(t.offeredPlayers ?? []), ...(t.offeredFuturePicks ?? [])].join(', ');
    const gets = [...(t.requestedOveralls ?? []).map((o: number) => `#${o}`), ...(t.requestedPlayers ?? []), ...(t.requestedFuturePicks ?? [])].join(', ');
    return (
      <div className="tweet-card breaking">
        <div className="tweet-avatar-placeholder" style={{ background: 'rgba(220,38,38,0.15)', color: 'var(--accent-breaking)' }}>!</div>
        <div className="tweet-body">
          <div className="tweet-tag breaking">BREAKING</div>
          <div className="tweet-text">
            <strong>TRADE!</strong> {t1} sends {gives} to {t2} for {gets}
          </div>
          <span className="tweet-time">{timeAgo(item.timestamp)}</span>
        </div>
      </div>
    );
  }

  if (item.type === 'trade-chatter') {
    const d = item.data;
    const insider = randomFeedInsider();
    return (
      <div className="tweet-card chatter">
        <div className="tweet-avatar-placeholder">~</div>
        <div className="tweet-body">
          <div className="tweet-header">
            <span className="tweet-name">{insider.name}</span>
            <span className="tweet-handle">{insider.handle}</span>
            <span className="tweet-time">{timeAgo(item.timestamp)}</span>
          </div>
          <div className="tweet-text">{d.reasoning?.split('\n')[0] ?? `${d.team1} and ${d.team2} — ${d.outcome}`}</div>
        </div>
      </div>
    );
  }

  if (item.type === 'trade-cancelled') {
    const d = item.data;
    const t = d.trade ?? d;
    const t1 = teams[t.proposerTeam]?.name ?? t.proposerTeam;
    const t2 = teams[t.receiverTeam]?.name ?? t.receiverTeam;
    return (
      <div className="tweet-card pick">
        <div className="tweet-avatar-placeholder" style={{ color: 'var(--text-dim)' }}>x</div>
        <div className="tweet-body">
          <div className="tweet-text" style={{ color: 'var(--text-secondary)' }}>
            Trade talks between {t1} and {t2} fell through.
          </div>
          <span className="tweet-time">{timeAgo(item.timestamp)}</span>
        </div>
      </div>
    );
  }

  if (item.type === 'cpu-offer') {
    const o = item.data;
    const t1 = teams[o.proposerTeam]?.name ?? o.proposerTeam;
    return (
      <div className="tweet-card cpu-buzz">
        <div className="tweet-avatar-placeholder">?</div>
        <div className="tweet-body">
          <div className="tweet-header">
            <span className="tweet-name">League Sources</span>
            <span className="tweet-handle">@LeagueSources</span>
            <span className="tweet-time">{timeAgo(item.timestamp)}</span>
          </div>
          <div className="tweet-text">Hearing buzz that {t1} is fielding calls about a trade... {o.pitch ? `"${o.pitch.slice(0, 120)}"` : ''}</div>
        </div>
      </div>
    );
  }

  if (item.type === 'pick-made') {
    const p = item.data;
    const tName = teams[p.team]?.name ?? p.team;
    const color = teams[p.team] ? teamColorToCSS(teams[p.team].color) : 'var(--text-dim)';
    return (
      <div className="tweet-card pick">
        <div className="pick-team-chip" style={{ background: color, width: 32, height: 32, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontSize: '0.75rem', color: '#fff', flexShrink: 0 }}>
          {p.overall}
        </div>
        <div className="tweet-body">
          <div className="tweet-text">
            <strong>{tName}</strong> selects <strong>{p.prospectName}</strong>, {p.pos}, {p.school}
          </div>
          <span className="tweet-time">{timeAgo(item.timestamp)}</span>
        </div>
      </div>
    );
  }

  return null;
}
