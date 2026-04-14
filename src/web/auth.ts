import * as crypto from 'crypto';

const SECRET = process.env.WEB_AUTH_SECRET ?? '';

export interface TokenPayload {
  roomCode: string;
  userId: string;
  displayName: string;
  admin: boolean;
  exp: number; // ms since epoch
}

export function sign(payload: TokenPayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('hex');
  return `${data}.${sig}`;
}

export function verify(token: string): TokenPayload | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as TokenPayload;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function ensureSecret(): void {
  if (!SECRET) throw new Error('WEB_AUTH_SECRET must be set when WEB_PORT is configured');
}
