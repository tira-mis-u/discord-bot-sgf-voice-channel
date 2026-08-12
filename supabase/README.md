# Supabase PostgreSQL migration

## Required credentials

Use a PostgreSQL connection string from Supabase Connect. The anon API key alone is not a database connection.

```env
DATABASE_URL=postgresql://...pooler.supabase.com:5432/postgres
DIRECT_DATABASE_URL=postgresql://postgres:...@db.<project>.supabase.co:5432/postgres
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-side-only-key>
```

For a persistent Discord bot worker, use Supavisor session mode on port 5432 when direct IPv6 is unavailable. Use the direct URL for migrations and backups. Never expose the service-role key or database URI to browser JavaScript.

## Apply schema and migrate SQLite data

The idempotent PostgreSQL schema is in:

```text
supabase/migrations/0001_initial_schema.sql
```

To apply the schema and copy existing SQLite data while preserving IDs:

```bash
DATABASE_URL='postgresql://...' npm run db:migrate:supabase
```

The script copies guild settings, normalized creator channels, products, rooms, payments, payment events, entitlements, room access, reminder records and unmatched SePay transactions. OAuth sessions are intentionally not copied because new sessions go to Redis when Redis is configured.

## Runtime selection

- `DATABASE_URL` set: runtime uses PostgreSQL.
- `DATABASE_URL` empty: runtime uses SQLite through an async compatibility adapter.
- PostgreSQL mode does not initialize or write SQLite.
- `/api/health` reports `databaseBackend`.

All application stores are now asynchronous so the Discord bot, payment service and Express dashboard use the same PostgreSQL source of truth.

## Security

The migration enables RLS and revokes direct table access from Supabase `anon` and `authenticated` roles. The Express backend connects with the server-side database URI and remains the only application layer for bot data.
