# Redis runtime

Redis is optional and never replaces PostgreSQL as the source of truth.

## Credentials

Use either standard Redis:

```env
REDIS_URL=rediss://...
```

or Upstash REST:

```env
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...
```

If both are configured, `REDIS_URL` is preferred. If neither is configured, the app falls back to in-memory cache for local development.

## Data stored in Redis

- Discord OAuth sessions with TTL.
- Discord member snapshots for five minutes.
- Distributed room-creation locks.
- Room-password attempt counters.

## Data kept in PostgreSQL

- Guild and creator setup.
- Products and prices.
- Active room ownership and settings.
- Room access grants.
- Payments and idempotency events.
- Premium entitlements and expiry reminders.
- Unmatched SePay transactions.

`/api/health` reports `cacheBackend` as `redis`, `upstash` or `memory` without exposing credentials.
