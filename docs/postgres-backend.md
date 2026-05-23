# Postgres Backend

Phase 6.5 moves multi-instance state from local JSON files to Postgres.

## Enable

```bash
DATABASE_URL=postgres://sound:sound@localhost:5432/sound_browser \
SOUND_JOB_BACKEND=postgres \
SOUND_GRAPH_BACKEND=postgres \
SOUND_MEMORY_BACKEND=postgres \
SOUND_CACHE_BACKEND=postgres \
SOUND_AUDIT_BACKEND=postgres \
bun run db:init
```

Start server with same environment:

```bash
DATABASE_URL=postgres://sound:sound@localhost:5432/sound_browser \
SOUND_JOB_BACKEND=postgres \
SOUND_GRAPH_BACKEND=postgres \
SOUND_MEMORY_BACKEND=postgres \
SOUND_CACHE_BACKEND=postgres \
SOUND_AUDIT_BACKEND=postgres \
bun run start
```

If `DATABASE_URL` is set and a specific backend variable is not set, jobs, graphs, and memory auto-select Postgres.

## Docker Postgres

```bash
docker compose --profile postgres up postgres
```

## Backend Checks

```bash
curl -s http://localhost:3001/jobs/backend -H "Authorization: Bearer dev-key"
curl -s http://localhost:3001/graphs/backend -H "Authorization: Bearer dev-key"
curl -s http://localhost:3001/memory/backend -H "Authorization: Bearer dev-key"
```

Expected:

```json
{"backend":"postgres","postgres_ready":true}
```

## Tables

- `sound_jobs`
- `sound_graphs`
- `sound_site_memories`
- `sound_semantic_cache`
- `sound_audits`

Local file fallback remains available when Postgres is not configured or initialization fails.
