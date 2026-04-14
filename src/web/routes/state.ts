import { Router } from 'express';
import type { RoomManager } from '../RoomManager';
import { TEAMS } from '../../data/teams';
import { PROSPECT_BY_RANK } from '../../data/prospects';

export function stateRoutes(rm: RoomManager): Router {
  const router = Router();

  // Full state snapshot
  router.get('/:code/state', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    res.json({
      state: room.adapter.engine.getState(),
      teams: TEAMS,
    });
  });

  // Available prospects (paginated)
  router.get('/:code/prospects', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const pos = req.query.pos as string | undefined;
    const page = parseInt(req.query.page as string) || 0;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 50, 100);
    const result = room.adapter.engine.getAvailableProspects(pos, page, pageSize);
    res.json(result);
  });

  return router;
}
