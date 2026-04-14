import { Router } from 'express';
import type { RoomManager } from '../RoomManager';
import type { TokenPayload } from '../auth';

export function boardRoutes(rm: RoomManager): Router {
  const router = Router();

  // Get user's custom board
  router.get('/:code/board', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const teamAbbr = room.adapter.engine.getUserTeam(user.userId);
    if (!teamAbbr) { res.json({ entries: [], total: 0, totalPages: 0, page: 1, strategy: null }); return; }

    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 50, 100);
    const result = room.adapter.engine.getMyBoardPage(teamAbbr, page, pageSize);
    const strategy = room.adapter.engine.getStrategyPrompt(teamAbbr) ?? null;
    const notes = room.adapter.engine.getStrategyNotes(teamAbbr);
    res.json({ ...result, strategy, notes });
  });

  // Submit a custom board (array of player names)
  router.post('/:code/board/submit', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const teamAbbr = room.adapter.engine.getUserTeam(user.userId);
    if (!teamAbbr) { res.status(400).json({ success: false, error: 'Register for a team first.' }); return; }

    const { names } = req.body ?? {};
    if (!Array.isArray(names) || names.length === 0) {
      res.status(400).json({ success: false, error: 'names array is required.' }); return;
    }
    const result = room.adapter.engine.submitBoard(teamAbbr, names);
    res.json({ success: true, ...result });
  });

  // Clear board/strategy
  router.post('/:code/board/clear', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const teamAbbr = room.adapter.engine.getUserTeam(user.userId);
    if (!teamAbbr) { res.status(400).json({ success: false, error: 'Register for a team first.' }); return; }

    const what = (req.body?.what as 'board' | 'strategy' | 'all') ?? 'all';
    room.adapter.engine.clearBoard(teamAbbr, what);
    res.json({ success: true });
  });

  // Set strategy prompt
  router.post('/:code/board/strategy', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const teamAbbr = room.adapter.engine.getUserTeam(user.userId);
    if (!teamAbbr) { res.status(400).json({ success: false, error: 'Register for a team first.' }); return; }

    const { prompt } = req.body ?? {};
    if (!prompt) { res.status(400).json({ success: false, error: 'prompt is required.' }); return; }
    room.adapter.engine.setStrategyPrompt(teamAbbr, prompt);
    res.json({ success: true });
  });

  // Reorder board (move a player to a new position)
  router.post('/:code/board/reorder', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const teamAbbr = room.adapter.engine.getUserTeam(user.userId);
    if (!teamAbbr) { res.status(400).json({ success: false, error: 'Register for a team first.' }); return; }

    const { fromIndex, toIndex } = req.body ?? {};
    if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') {
      res.status(400).json({ success: false, error: 'fromIndex and toIndex are required.' }); return;
    }
    const board = room.adapter.engine.getCustomBoard(teamAbbr);
    if (fromIndex < 0 || fromIndex >= board.length || toIndex < 0 || toIndex >= board.length) {
      res.status(400).json({ success: false, error: 'Index out of range.' }); return;
    }
    const [item] = board.splice(fromIndex, 1);
    board.splice(toIndex, 0, item);
    // Re-submit the reordered ranks as names to persist
    // Direct manipulation — just update the board data directly
    (room.adapter.engine as any).boardData.customBoards[teamAbbr] = board;
    void (room.adapter.engine as any).persistBoardData();
    res.json({ success: true });
  });

  // Add prospect to board
  router.post('/:code/board/add', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const teamAbbr = room.adapter.engine.getUserTeam(user.userId);
    if (!teamAbbr) { res.status(400).json({ success: false, error: 'Register for a team first.' }); return; }

    const { rank, position } = req.body ?? {};
    if (typeof rank !== 'number') { res.status(400).json({ success: false, error: 'rank is required.' }); return; }
    const board = room.adapter.engine.getCustomBoard(teamAbbr);
    if (board.includes(rank)) { res.status(400).json({ success: false, error: 'Already on board.' }); return; }

    // Add at specified position or end
    const pos = typeof position === 'number' ? position : board.length;
    board.splice(pos, 0, rank);
    (room.adapter.engine as any).boardData.customBoards[teamAbbr] = board;
    void (room.adapter.engine as any).persistBoardData();
    res.json({ success: true });
  });

  // Remove prospect from board
  router.post('/:code/board/remove', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const teamAbbr = room.adapter.engine.getUserTeam(user.userId);
    if (!teamAbbr) { res.status(400).json({ success: false, error: 'Register for a team first.' }); return; }

    const { rank } = req.body ?? {};
    if (typeof rank !== 'number') { res.status(400).json({ success: false, error: 'rank is required.' }); return; }
    const board = room.adapter.engine.getCustomBoard(teamAbbr);
    const idx = board.indexOf(rank);
    if (idx === -1) { res.status(400).json({ success: false, error: 'Not on board.' }); return; }
    board.splice(idx, 1);
    (room.adapter.engine as any).boardData.customBoards[teamAbbr] = board;
    void (room.adapter.engine as any).persistBoardData();
    res.json({ success: true });
  });

  // Get inventory for a team
  router.get('/:code/inventory/:teamAbbr', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const { teamAbbr } = req.params;
    const engine = room.adapter.engine;

    const futurePicks = engine.getFuturePicksForTeam(teamAbbr);
    const futureRights = engine.getFuturePickRightsForTeam(teamAbbr);
    const draftedPicks = engine.getTeamPicks(teamAbbr);
    const roster = engine.getFullRoster(teamAbbr);
    const capInfo = engine.trades.getTeamCapInfo(teamAbbr);

    res.json({ futurePicks, futureRights, draftedPicks, roster, capInfo });
  });

  return router;
}
