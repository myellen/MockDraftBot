import React, { useState, useEffect } from 'react';
import '../styles/timer.css';

interface TimerProps {
  expiresAt: number | null;
  timerSeconds: number | null;
  size?: number;
}

export function Timer({ expiresAt, timerSeconds, size = 44 }: TimerProps) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!expiresAt) { setRemaining(null); return; }

    const tick = () => {
      const r = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      setRemaining(r);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  if (remaining === null || !timerSeconds) return null;

  const r = (size - 6) / 2;
  const circumference = 2 * Math.PI * r;
  const fraction = remaining / timerSeconds;
  const dashoffset = circumference * (1 - fraction);
  const urgent = remaining <= 10;

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const label = mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : String(secs);

  return (
    <div className="timer-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle className="timer-ring-bg" cx={size / 2} cy={size / 2} r={r} />
        <circle
          className={`timer-ring-progress${urgent ? ' urgent' : ''}`}
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeDasharray={circumference}
          strokeDashoffset={dashoffset}
        />
      </svg>
      <span className={`timer-ring-label${urgent ? ' urgent' : ''}`}>{label}</span>
    </div>
  );
}
