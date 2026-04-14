import { Router } from 'express';
import type { RoomManager } from '../RoomManager';

export function roomRoutes(rm: RoomManager): Router {
  const router = Router();

  // Create a new room
  router.post('/', (_req, res) => {
    const { roomCode, token } = rm.createRoom();
    res.json({ roomCode, token });
  });

  // Join an existing room
  router.post('/:code/join', (req, res) => {
    const { code } = req.params;
    const { displayName } = req.body ?? {};
    if (!displayName || typeof displayName !== 'string') {
      res.status(400).json({ success: false, error: 'displayName is required.' });
      return;
    }
    if (!rm.hasRoom(code)) {
      res.status(404).json({ success: false, error: 'Room not found.' });
      return;
    }
    const result = rm.joinRoom(code, displayName.trim().slice(0, 32));
    if (!result) {
      res.status(404).json({ success: false, error: 'Room not found.' });
      return;
    }
    res.json(result);
  });

  return router;
}
