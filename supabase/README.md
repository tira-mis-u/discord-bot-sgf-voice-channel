# Supabase PostgreSQL migration

## Credentials required

The backend database adapter should use a PostgreSQL connection string, not the public anon API key.

Set these without committing their values:

```env
DATABASE_URL=postgresql://...pooler.supabase.com:5432/postgres
DIRECT_DATABASE_URL=postgresql://postgres:...@db.<project>.supabase.co:5432/postgres
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-side-only-key>
```

For the persistent Discord bot worker, use Supavisor session mode on port 5432 when direct IPv6 is unavailable. Use the direct URL for migrations and backups. The service role key is optional for the SQL adapter and must never be exposed to browser JavaScript.

## Apply the schema

Run `supabase/migrations/0001_initial_schema.sql` in the Supabase SQL editor, or with the Supabase CLI.

The schema enables RLS and grants no browser role access. The Express backend remains the only application layer allowed to read or write bot data.

## Migration status

- PostgreSQL schema: prepared.
- Environment contract: prepared.
- SQLite-on-Vercel crash guard: implemented with temporary `/tmp` fallback.
- Runtime store adapter: still SQLite until the async PostgreSQL repository migration is completed.
- SQLite data copy: not run yet.

Do not treat `/tmp/sgf.sqlite` on Vercel as persistent storage.
