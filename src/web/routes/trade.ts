import { Router } from 'express';
import type { RoomManager } from '../RoomManager';
import type { TokenPayload } from '../auth';

export function tradeRoutes(rm: RoomManager): Router {
  const router = Router();

  // Propose a trade (accepts receiverTeam instead of receiverUserId for web convenience)
  router.post('/:code/trade/propose', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const {
      receiverTeam, receiverUserId: rawReceiverUserId,
      offeredOveralls, requestedOveralls,
      offeredPlayers, requestedPlayers,
      offeredFuturePicks, requestedFuturePicks,
    } = req.body ?? {};

    // Resolve receiverUserId from receiverTeam if needed
    const state = room.adapter.engine.getState();
    let receiverUserId = rawReceiverUserId;
    const isCPU = receiverTeam && !state.assignments[receiverTeam];
    if (!receiverUserId && receiverTeam) {
      receiverUserId = state.assignments[receiverTeam] ?? 'cpu';
    }
    if (!receiverUserId) {
      res.status(400).json({ success: false, error: 'receiverTeam or receiverUserId is required.' });
      return;
    }

    const result = await room.adapter.engine.trades.proposeTrade(
      user.userId, receiverUserId,
      offeredOveralls ?? [], requestedOveralls ?? [],
      offeredPlayers ?? [], requestedPlayers ?? [],
      offeredFuturePicks ?? [], requestedFuturePicks ?? [],
      isCPU ? receiverTeam : undefined,
    );

    if (result.success && result.trade && isCPU) {
      // Fire-and-forget: AI GM evaluates the trade
      void room.adapter.engine.aiGM.handleHumanProposal(result.trade).catch(() => {});
    }

    res.json(result);
  });

  // Accept a trade
  router.post('/:code/trade/accept', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const { tradeId } = req.body ?? {};
    if (!tradeId) { res.status(400).json({ success: false, error: 'tradeId is required.' }); return; }
    const result = await room.adapter.engine.trades.acceptTrade(user.userId, tradeId);
    res.json(result);
  });

  // Decline a trade
  router.post('/:code/trade/decline', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const { tradeId } = req.body ?? {};
    if (!tradeId) { res.status(400).json({ success: false, error: 'tradeId is required.' }); return; }
    const result = room.adapter.engine.trades.declineTrade(user.userId, tradeId);
    res.json(result);
  });

  // Accept a CPU offer
  router.post('/:code/cpu-offer/accept', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const { offerId } = req.body ?? {};
    if (!offerId) { res.status(400).json({ success: false, error: 'offerId is required.' }); return; }
    const result = await room.adapter.engine.aiGM.handleOfferAccept(offerId, user.userId);
    res.json(result);
  });

  // Decline a CPU offer
  router.post('/:code/cpu-offer/decline', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const { offerId } = req.body ?? {};
    if (!offerId) { res.status(400).json({ success: false, error: 'offerId is required.' }); return; }
    const result = await room.adapter.engine.aiGM.handleOfferDecline(offerId, user.userId);
    res.json(result);
  });

  return router;
}
