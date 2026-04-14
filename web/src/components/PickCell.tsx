import React from 'react';
import type { PickSlot, CompletedPick, Team } from '../types';
import { teamColorToCSS } from '../types';

function teamLogoUrl(abbr: string): string {
  return `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png`;
}

interface PickCellProps {
  slot: PickSlot;
  pick: CompletedPick | undefined;
  teams: Record<string, Team>;
  isCurrent: boolean;
}

export function PickCell({ slot, pick, teams, isCurrent }: PickCellProps) {
  const team = teams[slot.currentTeam];
  const color = team ? teamColorToCSS(team.color) : '#444';
  const filled = !!pick;

  const classes = [
    'pick-cell',
    filled && 'filled',
    isCurrent && 'current',
    slot.isTraded && 'traded',
  ].filter(Boolean).join(' ');

  return (
    <div className={classes} style={{ borderLeftColor: color, background: filled ? `linear-gradient(90deg, ${color}0D 0%, transparent 40%)` : undefined }}>
      <span className="pick-number">{slot.overall}</span>
      <img className="pick-team-logo" src={teamLogoUrl(slot.currentTeam)} alt={slot.currentTeam} />
      {filled ? (
        <div className="pick-prospect">
          <div className="pick-prospect-name">{pick.prospectName}</div>
          <div className="pick-prospect-info">{pick.pos} — {pick.school}</div>
        </div>
      ) : (
        <span className="pick-team-name">{team?.city ?? slot.currentTeam}</span>
      )}
    </div>
  );
}
