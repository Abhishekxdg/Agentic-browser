const bunSql = (globalThis as any).Bun?.sql as undefined | ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<Array<Record<string, unknown>>>);

export async function initializePostgresSchema(): Promise<{ ok: boolean; tables: string[]; error?: string }> {
  if (!bunSql) return { ok: false, tables: [], error: "Bun.sql is not available" };

  const tables: string[] = [];
  try {
    await bunSql`
      CREATE TABLE IF NOT EXISTS sound_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `;
    await bunSql`CREATE INDEX IF NOT EXISTS idx_sound_jobs_status_created ON sound_jobs (status, created_at)`;
    tables.push("sound_jobs");

    await bunSql`
      CREATE TABLE IF NOT EXISTS sound_graphs (
        org_id TEXT NOT NULL,
        site_host TEXT NOT NULL,
        graph_version INTEGER NOT NULL,
        workflow_count INTEGER NOT NULL,
        saved_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (org_id, site_host)
      )
    `;
    await bunSql`CREATE INDEX IF NOT EXISTS idx_sound_graphs_org_saved ON sound_graphs (org_id, saved_at)`;
    tables.push("sound_graphs");

    await bunSql`
      CREATE TABLE IF NOT EXISTS sound_site_memories (
        site_host TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        last_updated TEXT NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 0
      )
    `;
    await bunSql`CREATE INDEX IF NOT EXISTS idx_sound_site_memories_updated ON sound_site_memories (last_updated)`;
    tables.push("sound_site_memories");

    await bunSql`
      CREATE TABLE IF NOT EXISTS sound_semantic_cache (
        key TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        payload TEXT NOT NULL,
        cached_at INTEGER NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0
      )
    `;
    await bunSql`CREATE INDEX IF NOT EXISTS idx_sound_semantic_cache_url ON sound_semantic_cache (url)`;
    tables.push("sound_semantic_cache");

    await bunSql`
      CREATE TABLE IF NOT EXISTS sound_audits (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload TEXT NOT NULL,
        entry_hash TEXT NOT NULL,
        prev_hash TEXT
      )
    `;
    await bunSql`CREATE INDEX IF NOT EXISTS idx_sound_audits_org_ts ON sound_audits (org_id, timestamp)`;
    tables.push("sound_audits");

    return { ok: true, tables };
  } catch (err) {
    return { ok: false, tables, error: err instanceof Error ? err.message : String(err) };
  }
}

if (import.meta.main) {
  const result = await initializePostgresSchema();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
