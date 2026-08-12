import crypto from 'node:crypto';
import { cache } from '../cache.js';
import { store } from '../db.js';
import type { AuthSession, OAuthGuild, SessionUser } from '../types.js';

const sessionKey = (id: string) => `session:${id}`;
const ttlFor = (expiresAt: number) => Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000));

export const sessionStore = {
  async create(input: { user: SessionUser; accessToken: string; refreshToken: string; expiresAt: number; guilds: OAuthGuild[] }): Promise<AuthSession> {
    if (cache.backend === 'memory') return store.createSession(input);
    const session: AuthSession = { id: crypto.randomBytes(32).toString('hex'), ...input };
    await cache.setJson(sessionKey(session.id), session, ttlFor(session.expiresAt));
    return session;
  },

  async get(id: string): Promise<AuthSession | undefined> {
    if (cache.backend === 'memory') return store.getSession(id);
    const session = await cache.getJson<AuthSession>(sessionKey(id));
    if (!session || session.expiresAt <= Date.now()) {
      if (session) await cache.del(sessionKey(id));
      return undefined;
    }
    return session;
  },

  async update(id: string, input: Partial<Pick<AuthSession, 'accessToken' | 'refreshToken' | 'expiresAt' | 'guilds'>>): Promise<AuthSession | undefined> {
    if (cache.backend === 'memory') return store.updateSession(id, input);
    const current = await this.get(id);
    if (!current) return undefined;
    const next = { ...current, ...input };
    await cache.setJson(sessionKey(id), next, ttlFor(next.expiresAt));
    return next;
  },

  async delete(id: string): Promise<void> {
    if (cache.backend === 'memory') return store.deleteSession(id);
    await cache.del(sessionKey(id));
  },
};
