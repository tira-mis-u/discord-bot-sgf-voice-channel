import { createClient, type RedisClientType } from 'redis';
import { Redis as UpstashRedis } from '@upstash/redis';
import { config } from './config.js';

interface MemoryEntry { value: string; expiresAt: number }
const memory = new Map<string, MemoryEntry>();
let standardClient: RedisClientType | undefined;
let standardConnecting: Promise<RedisClientType> | undefined;
const upstash = config.redis.upstashRestUrl && config.redis.upstashRestToken
  ? new UpstashRedis({ url: config.redis.upstashRestUrl, token: config.redis.upstashRestToken })
  : undefined;

const prefix = String(process.env.REDIS_PREFIX || 'study-voice').replace(/:+$/, '');
const keyOf = (key: string) => `${prefix}:${key}`;

async function getStandardClient(): Promise<RedisClientType | undefined> {
  if (!config.redis.url) return undefined;
  if (standardClient?.isReady) return standardClient;
  if (!standardConnecting) {
    const client = createClient({ url: config.redis.url });
    client.on('error', (error) => console.error('[redis]', error instanceof Error ? error.message : error));
    standardConnecting = client.connect().then(() => {
      standardClient = client as RedisClientType;
      return standardClient;
    }).finally(() => { standardConnecting = undefined; });
  }
  return standardConnecting;
}

function memoryGet(key: string): string | undefined {
  const item = memory.get(key);
  if (!item) return undefined;
  if (item.expiresAt && item.expiresAt <= Date.now()) {
    memory.delete(key);
    return undefined;
  }
  return item.value;
}

function memorySet(key: string, value: string, ttlSeconds = 0): void {
  memory.set(key, { value, expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0 });
}

export const cache = {
  backend: config.redis.url ? 'redis' as const : upstash ? 'upstash' as const : 'memory' as const,

  async get(key: string): Promise<string | undefined> {
    const fullKey = keyOf(key);
    try {
      const client = await getStandardClient();
      if (client) return await client.get(fullKey) || undefined;
      if (upstash) return await upstash.get<string>(fullKey) || undefined;
    } catch (error) {
      console.warn('[cache] get failed, using memory fallback', error instanceof Error ? error.message : error);
    }
    return memoryGet(fullKey);
  },

  async set(key: string, value: string, ttlSeconds = 0): Promise<void> {
    const fullKey = keyOf(key);
    try {
      const client = await getStandardClient();
      if (client) {
        if (ttlSeconds > 0) await client.set(fullKey, value, { EX: ttlSeconds });
        else await client.set(fullKey, value);
        return;
      }
      if (upstash) {
        if (ttlSeconds > 0) await upstash.set(fullKey, value, { ex: ttlSeconds });
        else await upstash.set(fullKey, value);
        return;
      }
    } catch (error) {
      console.warn('[cache] set failed, using memory fallback', error instanceof Error ? error.message : error);
    }
    memorySet(fullKey, value, ttlSeconds);
  },

  async getJson<T>(key: string): Promise<T | undefined> {
    const raw = await this.get(key);
    if (!raw) return undefined;
    try { return JSON.parse(raw) as T; } catch { return undefined; }
  },

  async setJson(key: string, value: unknown, ttlSeconds = 0): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  },

  async del(key: string): Promise<void> {
    const fullKey = keyOf(key);
    try {
      const client = await getStandardClient();
      if (client) { await client.del(fullKey); return; }
      if (upstash) { await upstash.del(fullKey); return; }
    } catch (error) {
      console.warn('[cache] delete failed', error instanceof Error ? error.message : error);
    }
    memory.delete(fullKey);
  },

  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const fullKey = keyOf(key);
    try {
      const client = await getStandardClient();
      if (client) return (await client.set(fullKey, value, { NX: true, EX: ttlSeconds })) === 'OK';
      if (upstash) return (await upstash.set(fullKey, value, { nx: true, ex: ttlSeconds })) === 'OK';
    } catch (error) {
      console.warn('[cache] lock failed, using memory fallback', error instanceof Error ? error.message : error);
    }
    if (memoryGet(fullKey) !== undefined) return false;
    memorySet(fullKey, value, ttlSeconds);
    return true;
  },

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const fullKey = keyOf(key);
    try {
      const client = await getStandardClient();
      if (client) {
        const value = await client.incr(fullKey);
        if (value === 1) await client.expire(fullKey, ttlSeconds);
        return value;
      }
      if (upstash) {
        const value = await upstash.incr(fullKey);
        if (value === 1) await upstash.expire(fullKey, ttlSeconds);
        return value;
      }
    } catch (error) {
      console.warn('[cache] increment failed, using memory fallback', error instanceof Error ? error.message : error);
    }
    const current = Number(memoryGet(fullKey) || 0) + 1;
    memorySet(fullKey, String(current), ttlSeconds);
    return current;
  },

  async ping(): Promise<boolean> {
    try {
      const client = await getStandardClient();
      if (client) return await client.ping() === 'PONG';
      if (upstash) return await upstash.ping() === 'PONG';
      return true;
    } catch {
      return false;
    }
  },

  async close(): Promise<void> {
    if (standardClient?.isOpen) await standardClient.quit();
  },
};
