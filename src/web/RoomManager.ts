import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type WebSocket from 'ws';
import { WebAdapter, WEB_STATE_PREFIX } from './WebAdapter';
import { sign, type TokenPayload } from './auth';

interface Room {
  adapter: WebAdapter;
  /** Map of userId → displayName for connected users */
  users: Map<string, string>;
  createdAt: number;
}

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DATA_DIR = path.join(__dirname, '../../data');

export class RoomManager {
  private rooms = new Map<string, Room>();

  /** Rehydrate rooms from existing web state files on disk. */
  async loadExistingRooms(): Promise<void> {
    try {
      const files = await fs.readdir(DATA_DIR);
      const codes = files
        .filter(f => f.startsWith(WEB_STATE_PREFIX) && f.endsWith('.json'))
        .map(f => f.slice(WEB_STATE_PREFIX.length, -'.json'.length));

      for (const code of codes) {
        try {
          const adapter = await WebAdapter.create(code);
          const status = adapter.engine.getState().status;
          // Rehydrate any non-complete draft (idle rooms need to survive restarts too)
          if (status !== 'complete') {
            this.rooms.set(code, { adapter, users: new Map(), createdAt: Date.now() });
            adapter.engine.restoreTimer();
            console.log(`🌐 Rehydrated web room ${code} (status: ${status})`);
          }
        } catch (err) {
          console.warn(`Failed to rehydrate room ${code}:`, err);
        }
      }
    } catch {
      // data dir may not exist yet
    }
  }

  createRoom(): { roomCode: string; token: string } {
    let code: string;
    do {
      code = crypto.randomBytes(3).toString('hex').toUpperCase();
    } while (this.rooms.has(code));

    // Synchronously create a stub room — the adapter will be created async on first access
    // But we need the adapter now, so we do a blocking-style approach
    // Actually, use a placeholder and lazy-init in getRoom
    const userId = crypto.randomUUID();
    const token = sign({
      roomCode: code,
      userId,
      displayName: 'Host',
      admin: true,
      exp: Date.now() + TOKEN_TTL_MS,
    });

    // We'll initialize the adapter lazily since the constructor is async
    this.rooms.set(code, {
      adapter: null as unknown as WebAdapter,
      users: new Map([[userId, 'Host']]),
      createdAt: Date.now(),
    });

    return { roomCode: code, token };
  }

  async ensureAdapter(code: string): Promise<WebAdapter | null> {
    const room = this.rooms.get(code);
    if (!room) return null;
    if (!room.adapter) {
      room.adapter = await WebAdapter.create(code);
    }
    return room.adapter;
  }

  async getRoom(code: string): Promise<Room | null> {
    const room = this.rooms.get(code);
    if (!room) return null;
    await this.ensureAdapter(code);
    return room;
  }

  joinRoom(code: string, displayName: string): { token: string; userId: string } | null {
    const room = this.rooms.get(code);
    if (!room) return null;

    const userId = crypto.randomUUID();
    room.users.set(userId, displayName);

    const token = sign({
      roomCode: code,
      userId,
      displayName,
      admin: false,
      exp: Date.now() + TOKEN_TTL_MS,
    });

    return { token, userId };
  }

  async attachSocket(code: string, userId: string, ws: WebSocket): Promise<boolean> {
    const room = await this.getRoom(code);
    if (!room) return false;

    room.adapter.addSocket(ws);
    ws.on('close', () => room.adapter.removeSocket(ws));
    return true;
  }

  hasRoom(code: string): boolean {
    return this.rooms.has(code);
  }

  getRoomUserName(code: string, userId: string): string | undefined {
    return this.rooms.get(code)?.users.get(userId);
  }
}
