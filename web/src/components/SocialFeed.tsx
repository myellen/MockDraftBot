import React, { useRef, useEffect, useState } from 'react';
import { TweetCard } from './TweetCard';
import type { FeedItem, Team } from '../types';
import '../styles/feed.css';

interface SocialFeedProps {
  items: FeedItem[];
  teams: Record<string, Team>;
}

export function SocialFeed({ items, teams }: SocialFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevCountRef = useRef(items.length);

  // Auto-scroll to top on new items (feed is newest-first)
  useEffect(() => {
    if (autoScroll && items.length > prevCountRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
    prevCountRef.current = items.length;
  }, [items.length, autoScroll]);

  // Pause auto-scroll if user scrolls manually
  const handleScroll = () => {
    if (!scrollRef.current) return;
    setAutoScroll(scrollRef.current.scrollTop < 20);
  };

  return (
    <div className="panel social-feed feed-panel">
      <div className="feed-header">
        <span className="feed-brand">INSIDER<span className="feed-brand-x">X</span></span>
        {!autoScroll && (
          <button
            onClick={() => { setAutoScroll(true); scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}
            style={{ fontSize: '0.65rem', padding: '3px 8px' }}
          >
            New updates
          </button>
        )}
      </div>
      <div className="feed-items" ref={scrollRef} onScroll={handleScroll}>
        {items.length === 0 ? (
          <div className="feed-empty">
            Insider tweets and trade chatter will appear here as the draft unfolds...
          </div>
        ) : (
          items.map(item => <TweetCard key={item.id} item={item} teams={teams} />)
        )}
      </div>
    </div>
  );
}
