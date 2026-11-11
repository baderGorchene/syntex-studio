import { bulkSaveCanvasToDb, createGraphRevision, createProjectInDb, getAllConnectionsFromDb, getAllNodesFromDb, getDatabase, projectExistsInDb, renameProjectInDb } from '../db.ts';
import type { GraphConflict, GraphSnapshot } from './merge.ts';

// Desktop-only bookkeeping for the sync engine. SQLite only: every function refuses to run elsewhere.

export type SyncStatus = 'synced' | 'pending' | 'conflicts' | 'error' | 'no-access';
export interface SyncRow {
  projectId: string; accountId: string | null; offline: boolean;
  baseGraph: GraphSnapshot | null; baseVersion: number | null;   // null = never pushed
  status: SyncStatus; conflicts: GraphConflict[]; error: string | null;
  readOnly: boolean; deletedLocally: boolean; lastSyncedAt: number | null;
}
export interface SyncAccount { token: string; userId: string; cloudUrl: string; connectedAt: number }

const LOCAL_CLERK_ID = 'local_researcher';

function guard() {
  if (process.env.SYNTHEX_DESKTOP !== '1') throw new Error('The sync store is only available in the desktop app.');
}

/** The db.ts functions return T | Promise<T>; on SQLite they are synchronous. */
function now<T>(value: T | Promise<T>): T {
  if (value instanceof Promise) throw new Error('The sync store needs the local SQLite database.');
  return value;
}

let ready = false;
function db() {
  guard();
  const d = getDatabase();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        projectId TEXT PRIMARY KEY, accountId TEXT, offline INTEGER NOT NULL DEFAULT 0,
        baseGraph TEXT, baseVersion INTEGER, status TEXT NOT NULL DEFAULT 'pending',
        conflicts TEXT NOT NULL DEFAULT '[]', error TEXT, readOnly INTEGER NOT NULL DEFAULT 0,
        deletedLocally INTEGER NOT NULL DEFAULT 0, lastSyncedAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS sync_account (
        id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, userId TEXT NOT NULL,
        cloudUrl TEXT NOT NULL, connectedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_files (url TEXT PRIMARY KEY, projectId TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_local_files_project ON local_files(projectId);
    `);
    ready = true;
  }
  return d;
}

interface RawRow {
  projectId: string; accountId: string | null; offline: number; baseGraph: string | null; baseVersion: number | null;
  status: SyncStatus; conflicts: string; error: string | null; readOnly: number; deletedLocally: number; lastSyncedAt: number | null;
}

// Corrupt JSON must not throw (it would wedge the whole sync loop): treat baseGraph as null and
// mark the row 'error' so the engine reports it. Corrupt conflicts fall back to [].
function toRow(r: RawRow): SyncRow {
  let baseGraph: GraphSnapshot | null = null;
  let status = r.status;
  let error = r.error;
  if (r.baseGraph) {
    try { baseGraph = JSON.parse(r.baseGraph) as GraphSnapshot; } catch { status = 'error'; error = 'Stored sync data is damaged.'; }
  }
  let conflicts: GraphConflict[] = [];
  try {
    const parsed = JSON.parse(r.conflicts);
    if (Array.isArray(parsed)) conflicts = parsed;
  } catch { status = 'error'; error = error || 'Stored sync data is damaged.'; }
  return {
    projectId: r.projectId, accountId: r.accountId, offline: !!r.offline, baseGraph, baseVersion: r.baseVersion,
    status, conflicts, error, readOnly: !!r.readOnly, deletedLocally: !!r.deletedLocally, lastSyncedAt: r.lastSyncedAt
  };
}

function localUserId(): string {
  const row = db().prepare('SELECT id FROM users WHERE clerkId = ?').get(LOCAL_CLERK_ID) as { id: string } | undefined;
  return row?.id ?? LOCAL_CLERK_ID; // the project list matches on userId or clerkId
}

export const syncStore = {
  getAccount(): SyncAccount | null {
    const r = db().prepare('SELECT token, userId, cloudUrl, connectedAt FROM sync_account WHERE id = 1').get() as SyncAccount | undefined;
    return r ?? null;
  },
  setAccount(a: SyncAccount | null): void {
    const d = db();
    if (!a) { d.prepare('DELETE FROM sync_account WHERE id = 1').run(); return; }
    d.prepare(`INSERT INTO sync_account (id, token, userId, cloudUrl, connectedAt) VALUES (1, @token, @userId, @cloudUrl, @connectedAt)
      ON CONFLICT(id) DO UPDATE SET token = excluded.token, userId = excluded.userId, cloudUrl = excluded.cloudUrl, connectedAt = excluded.connectedAt`).run(a);
  },
  getRow(projectId: string): SyncRow | null {
    const r = db().prepare('SELECT * FROM sync_state WHERE projectId = ?').get(projectId) as RawRow | undefined;
    return r ? toRow(r) : null;
  },
  listRows(): SyncRow[] {
    return (db().prepare('SELECT * FROM sync_state').all() as RawRow[]).map(toRow);
  },
  saveRow(row: SyncRow): void {
    db().prepare(`INSERT OR REPLACE INTO sync_state
      (projectId, accountId, offline, baseGraph, baseVersion, status, conflicts, error, readOnly, deletedLocally, lastSyncedAt)
      VALUES (@projectId, @accountId, @offline, @baseGraph, @baseVersion, @status, @conflicts, @error, @readOnly, @deletedLocally, @lastSyncedAt)`).run({
      ...row,
      offline: row.offline ? 1 : 0,
      baseGraph: row.baseGraph ? JSON.stringify(row.baseGraph) : null,
      conflicts: JSON.stringify(row.conflicts ?? []),
      readOnly: row.readOnly ? 1 : 0,
      deletedLocally: row.deletedLocally ? 1 : 0
    });
  },
  deleteRow(projectId: string): void {
    db().prepare('DELETE FROM sync_state WHERE projectId = ?').run(projectId);
  },
  readLocalGraph(projectId: string): GraphSnapshot | null {
    const project = db().prepare('SELECT title FROM projects WHERE id = ?').get(projectId) as { title: string } | undefined;
    if (!project) return null;
    return {
      title: project.title,
      nodes: now(getAllNodesFromDb(projectId)),
      relationships: now(getAllConnectionsFromDb(projectId))
    };
  },
  writeLocalGraph(projectId: string, g: GraphSnapshot): void {
    db();
    if (now(projectExistsInDb(projectId))) {
      const nodes = now(getAllNodesFromDb(projectId));
      if (nodes.length) now(createGraphRevision(projectId, 'Before sync', nodes, now(getAllConnectionsFromDb(projectId))));
      now(renameProjectInDb(projectId, g.title));
    } else {
      now(createProjectInDb(projectId, g.title, localUserId(), null));
    }
    now(bulkSaveCanvasToDb(g.nodes, g.relationships, projectId)); // no baseVersion: local is authoritative here
  },
  addLocalFile(url: string, projectId: string): void {
    db().prepare('INSERT OR REPLACE INTO local_files (url, projectId) VALUES (?, ?)').run(url, projectId);
  },
  listLocalFiles(projectId: string): string[] {
    return (db().prepare('SELECT url FROM local_files WHERE projectId = ?').all(projectId) as { url: string }[]).map(r => r.url);
  },
  removeLocalFile(url: string): void {
    db().prepare('DELETE FROM local_files WHERE url = ?').run(url);
  }
};
