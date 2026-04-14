import * as http from 'http';
import * as path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { RoomManager } from './RoomManager';
import { verify, ensureSecret } from './auth';
import { roomRoutes } from './routes/rooms';
import { stateRoutes } from './routes/state';
import { draftRoutes } from './routes/draft';
import { tradeRoutes } from './routes/trade';
import { boardRoutes } from './routes/board';
import { aiRoutes } from './routes/ai';

export function startWebServer(rm: RoomManager, port: number): http.Server {
  ensureSecret();

  const app = express();
  app.use(express.json());

  // ─── Auth middleware for protected routes ───────────────────────────────────

  const authMiddleware: express.RequestHandler = (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'Missing authorization token.' });
      return;
    }
    const payload = verify(auth.slice(7));
    if (!payload) {
      res.status(401).json({ success: false, error: 'Invalid or expired token.' });
      return;
    }
    // Verify token matches the room in the URL
    const code = req.params.code;
    if (code && payload.roomCode !== code) {
      res.status(403).json({ success: false, error: 'Token does not match this room.' });
      return;
    }
    (req as any).user = payload;
    next();
  };

  // ─── Routes ────────────────────────────────────────────────────────────────

  app.use('/api/rooms', roomRoutes(rm));
  app.use('/api/rooms', authMiddleware, stateRoutes(rm));
  app.use('/api/rooms', authMiddleware, draftRoutes(rm));
  app.use('/api/rooms', authMiddleware, tradeRoutes(rm));
  app.use('/api/rooms', authMiddleware, boardRoutes(rm));
  app.use('/api/rooms', authMiddleware, aiRoutes(rm));

  // ─── Static SPA serving ────────────────────────────────────────────────────

  const distDir = path.join(__dirname, '../../web/dist');
  // Hashed assets can be cached forever; index.html must not be cached
  app.use(express.static(distDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
  // SPA fallback — Express 5 uses {*path} instead of *
  app.get('/{*path}', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(distDir, 'index.html'), (err) => {
      if (err) res.status(404).send('Not found');
    });
  });

  // ─── HTTP + WebSocket server ───────────────────────────────────────────────

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const roomCode = url.searchParams.get('room');
    const token = url.searchParams.get('token');
    if (!roomCode || !token) {
      socket.destroy();
      return;
    }

    const payload = verify(token);
    if (!payload || payload.roomCode !== roomCode) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      rm.attachSocket(roomCode, payload.userId, ws).then(ok => {
        if (!ok) ws.close(4004, 'Room not found');
      });
    });
  });

  server.listen(port, () => {
    console.log(`🌐 Web server listening on port ${port}`);
  });

  return server;
}
