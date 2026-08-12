# Redis preparation

Redis is optional and must not replace PostgreSQL as the source of truth.

Supported environment contract prepared in `.env.example`:

```env
# Standard TCP/TLS Redis
REDIS_URL=rediss://...

# Or Upstash REST
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
```

Planned Redis responsibilities:

- Discord member snapshot cache.
- Password-attempt rate limits.
- Room-creation distributed locks.
- SePay reconciliation cooldowns.
- OAuth sessions with TTL if desired.

Payments, entitlements, creator settings and room ownership remain in PostgreSQL. No Redis credential is exposed to frontend code.

The runtime Redis adapter is not enabled yet because the provider type was not confirmed. Use exactly one credential style above.
