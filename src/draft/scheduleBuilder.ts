import { PickSlot } from './types';
import { DRAFT_ORDER } from '../data/draftOrder';

export function buildSchedule(): PickSlot[] {
  return DRAFT_ORDER.map(p => ({
    overall:      p.overall,
    round:        p.round,
    roundPick:    p.roundPick,
    originalTeam: p.originalTeam,
    currentTeam:  p.currentTeam,
    isTraded:     p.originalTeam !== p.currentTeam,
  }));
}
