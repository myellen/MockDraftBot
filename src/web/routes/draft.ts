import { Router } from 'express';
import type { RoomManager } from '../RoomManager';
import type { TokenPayload } from '../auth';
import { generateInsiderTweet } from '../../llm/InsiderService';
import { INSIDERS, buildReporterPrompt } from '../../llm/insiderData';
import { isOllamaConfigured, chatText } from '../../llm/OllamaService';
import { TEAMS } from '../../data/teams';

export function draftRoutes(rm: RoomManager): Router {
  const router = Router();

  // Register for a team
  router.post('/:code/register', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const { teamAbbr } = req.body ?? {};
    if (!teamAbbr) { res.status(400).json({ success: false, error: 'teamAbbr is required.' }); return; }
    const result = await room.adapter.engine.registerTeam(teamAbbr, user.userId);
    if (result.success) {
      // Broadcast updated state so all clients see the registration
      room.adapter.broadcastState();
    }
    res.json(result);
  });

  // Setup draft config
  router.post('/:code/setup', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    if (!user.admin) { res.status(403).json({ success: false, error: 'Admin only.' }); return; }
    const config = req.body ?? {};
    // Set channelId sentinel for web rooms so engine.start() gate passes
    config.channelId = 'web:' + req.params.code;
    room.adapter.engine.setup(config);
    room.adapter.broadcastState();
    res.json({ success: true });
  });

  // Start draft
  router.post('/:code/start', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    if (!user.admin) { res.status(403).json({ success: false, error: 'Admin only.' }); return; }
    // Ensure channelId is set (setup may not have been called explicitly)
    if (!room.adapter.engine.getState().config.channelId) {
      room.adapter.engine.setup({ channelId: 'web:' + req.params.code });
    }
    const result = await room.adapter.engine.start();
    // Respond immediately — advance() runs async through CPU picks via events
    res.json(result);
  });

  // Pause draft
  router.post('/:code/pause', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    if (!user.admin) { res.status(403).json({ success: false, error: 'Admin only.' }); return; }
    room.adapter.engine.pause();
    room.adapter.broadcastState();
    res.json({ success: true });
  });

  // Resume draft
  router.post('/:code/resume', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    if (!user.admin) { res.status(403).json({ success: false, error: 'Admin only.' }); return; }
    await room.adapter.engine.resume();
    room.adapter.broadcastState();
    res.json({ success: true });
  });

  // Make a pick
  router.post('/:code/pick', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const { prospectRank } = req.body ?? {};
    if (typeof prospectRank !== 'number') { res.status(400).json({ success: false, error: 'prospectRank is required.' }); return; }
    const result = await room.adapter.engine.makePick(user.userId, prospectRank);
    res.json(result);
  });

  // Autopick
  router.post('/:code/autopick', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    const result = await room.adapter.engine.autoPick(user.userId);
    res.json(result);
  });

  // Reset draft
  router.post('/:code/reset', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    const user = (req as any).user as TokenPayload;
    if (!user.admin) { res.status(403).json({ success: false, error: 'Admin only.' }); return; }
    await room.adapter.engine.reset();
    room.adapter.broadcastState();
    res.json({ success: true });
  });

  // Trigger an insider tweet (manual)
  router.post('/:code/rumor', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    try {
      const result = await generateInsiderTweet(room.adapter.engine);
      room.adapter.engine.emit('insider:tweet', result);
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message ?? 'Failed to generate insider tweet.' });
    }
  });

  // Get insider personas
  router.get('/:code/insiders', async (_req, res) => {
    res.json({ insiders: INSIDERS.map(i => ({ name: i.name, handle: i.handle, avatar: i.avatar })) });
  });

  // Submit a leak
  router.post('/:code/leak', async (req, res) => {
    const room = await rm.getRoom(req.params.code);
    if (!room) { res.status(404).json({ success: false, error: 'Room not found.' }); return; }
    if (!isOllamaConfigured()) { res.status(503).json({ success: false, error: 'AI features not configured.' }); return; }

    const { info, insiderName } = req.body ?? {};
    if (!info || typeof info !== 'string') { res.status(400).json({ success: false, error: 'info is required.' }); return; }

    const insider = insiderName
      ? INSIDERS.find(i => i.name === insiderName) ?? INSIDERS[Math.floor(Math.random() * INSIDERS.length)]
      : INSIDERS[Math.floor(Math.random() * INSIDERS.length)];

    try {
      const engine = room.adapter.engine;
      const state = engine.getState();
      const user = (req as any).user as TokenPayload;

      const teamNames: Record<string, string> = {};
      for (const [abbr, team] of Object.entries(TEAMS)) teamNames[abbr] = team.name;

      const slot = engine.getCurrentSlot();
      const pickContext = slot
        ? `Current pick: Round ${slot.round}, Overall #${slot.overall} — ${teamNames[slot.currentTeam] ?? slot.currentTeam} on the clock.`
        : state.status === 'active' ? 'Draft is active.' : 'Draft is not currently active.';

      const recentPicks = engine.getLastNPicks(5).map(p =>
        `${teamNames[p.team] ?? p.team}: ${p.prospectName} (${p.pos}) in Round ${p.round}`
      ).join('; ');

      const leakerTeam = Object.entries(state.assignments).find(([, uid]) => uid === user.userId)?.[0];
      const leakerLabel = leakerTeam ? `a source within the ${teamNames[leakerTeam] ?? leakerTeam} organization` : 'an NFL source';

      const reporterPrompt = buildReporterPrompt(insider);
      const reporterInput = `Draft context: ${pickContext}${recentPicks ? ` Recent picks: ${recentPicks}.` : ''}\n\nA GM/source leaked you the following intel. Remember: you are the REPORTER, not the source. Translate their words into your reporting voice.\nSource (${leakerLabel}) says: "${info}"`;

      let tweet = await chatText(reporterPrompt, reporterInput, 1.2);
      tweet = tweet.replace(/^["'""'']/g, '').replace(/["'""'']$/g, '').trim();
      if (tweet.length > 280) tweet = tweet.slice(0, 277) + '...';

      console.log(`[leak] ${insider.name} tweet (${tweet.length} chars): ${tweet}`);

      // Broadcast to all clients via InsiderX feed
      engine.emit('insider:tweet', { name: insider.name, handle: insider.handle, avatar: insider.avatar, tweet });

      // Register leak so AI GMs factor it into trade decisions
      engine.aiGM.addLeak(leakerTeam ?? null, info, tweet);

      res.json({ success: true, name: insider.name, handle: insider.handle, avatar: insider.avatar, tweet });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message ?? 'Failed to generate leak.' });
    }
  });

  return router;
}
