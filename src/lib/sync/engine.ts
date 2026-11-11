import { mergeGraphs, sameGraph } from './merge.ts';
import type { GraphConflict, GraphSnapshot } from './merge.ts';
import type { SyncRow, syncStore } from './store.ts';

// Desktop sync loop (spec §6). The store and the cloud client are passed in, so tests can fake both.
// Anti-goal: never lose work. Every path that doesn't finish leaves baseGraph/baseVersion untouched,
// and nothing is pushed while a row has conflicts.

type Store = typeof syncStore;

export interface CloudClient {
  listProjects(): Promise<{
    userId: string; account: { email: string | null; name: string | null }; fileSync: boolean;
    projects: { id: string; title: string; version: number }[];
  }>;
  getGraph(id: string): Promise<{ status: 200; graph: GraphSnapshot; version: number } | { status: 403 | 410 }>;
  putGraph(id: string, g: GraphSnapshot, baseVersion: number): Promise<{ status: 200; version: number } | { status: 409; version: number } | { status: 413 | 400; error: string }>;
  upsertProject(id: string, title: string): Promise<{ status: 200 | 201 } | { status: 403 }>;
  deleteProject(id: string, baseVersion: number): Promise<{ status: 200 } | { status: 409; version: number } | { status: 403 | 410 }>;
  uploadFile(projectId: string, localUrl: string): Promise<string>;   // returns cloud URL
}

const UNREACHABLE = 'Could not reach the cloud.';
const ID_TAKEN = "This map's id is already used in the cloud.";
// The text store.ts sets when a row's stored JSON is corrupt (kept in sync by hand: engine.ts never loads store.ts).
const DAMAGED = 'Stored sync data is damaged.';
const MAX_RETRIES = 3;
const FILE_FIELDS = ['imageUrl', 'url', 'fileData'] as const;

// One holder per map at a time: a sync pass, or a destructive action from /api/sync (withProjectLock).
/** The cloud no longer accepts this device's token (revoked or signed out): the desktop must reconnect. */
export const isTokenRejected = (error: unknown) => (error as { status?: unknown } | null)?.status === 401;

const locks = new Map<string, { run: Promise<unknown>; pass: boolean }>();

const projectConflict = (id: string, reason: 'deleted-local' | 'deleted-remote'): GraphConflict =>
  ({ id: `project:${id}`, kind: 'project', itemId: id, reason });

/** sameGraph, but `metadata: {}` counts as no metadata (mergeGraphs drops empty metadata). */
export function unchanged(a: GraphSnapshot, b: GraphSnapshot): boolean {
  const clean = (g: GraphSnapshot) => ({
    ...g,
    nodes: g.nodes.map(n => (n.metadata && !Object.keys(n.metadata).length ? { ...n, metadata: undefined } : n))
  });
  return sameGraph(clean(a), clean(b));
}

/**
 * R23/R24: removing this map's local copy could lose work the cloud doesn't have. The row's status only moves during
 * a sync pass, so local edits since the last pass are found by comparing the local map with the synced base.
 */
export function hasUnsyncedWork(row: SyncRow | null, local: GraphSnapshot | null): boolean {
  return !row || row.status !== 'synced' || row.baseVersion === null || !row.baseGraph || !local || !unchanged(local, row.baseGraph);
}

/**
 * Rows this account syncs now. Conflicted rows wait for the user (Task 9); lost-access rows never sync again;
 * damaged rows may have lost their conflicts list, so pushing them could push choices nobody made.
 */
const eligible = (row: SyncRow, userId: string) =>
  row.accountId === userId && row.conflicts.length === 0 && row.status !== 'no-access' &&
  !(row.status === 'error' && row.error === DAMAGED);

/** Local-only files (tracked in local_files) that a node of `g` still points at. */
function referencedLocalFiles(store: Store, projectId: string, g: GraphSnapshot): string[] {
  const tracked = new Set(store.listLocalFiles(projectId));
  return [...new Set(g.nodes.flatMap(n => FILE_FIELDS.map(f => n[f]).filter((v): v is string => !!v && tracked.has(v))))];
}

async function uploadFiles(cloud: CloudClient, projectId: string, urls: string[]): Promise<Map<string, string>> {
  const cloudUrls = new Map<string, string>();
  for (const url of urls) cloudUrls.set(url, await cloud.uploadFile(projectId, url));
  return cloudUrls;
}

function rewriteFileUrls(g: GraphSnapshot, cloudUrls: Map<string, string>): GraphSnapshot {
  const nodes = g.nodes.map(n => {
    const out = { ...n };
    for (const f of FILE_FIELDS) {
      const value = n[f];
      if (value && cloudUrls.has(value)) out[f] = cloudUrls.get(value);
    }
    return out;
  });
  return { ...g, nodes };
}

async function syncLocked(store: Store, cloud: CloudClient, projectId: string, fileSync?: boolean): Promise<SyncRow> {
  const row = store.getRow(projectId);
  if (!row) throw new Error(`No sync state for map ${projectId}.`);
  const account = store.getAccount();
  if (!account || !eligible(row, account.userId)) return row;

  // `current` follows every save, so a later failure keeps a base that already advanced.
  let current = row;
  const save = (changes: Partial<SyncRow>): SyncRow => {
    current = { ...current, ...changes };
    store.saveRow(current);
    return current;
  };

  try {
    if (row.deletedLocally) {
      if (row.baseVersion !== null) {
        const result = await cloud.deleteProject(projectId, row.baseVersion);
        if (result.status === 409) return save({ status: 'conflicts', conflicts: [projectConflict(projectId, 'deleted-local')], error: null });
        // Not this user's map to delete: stop syncing it, but keep the row so the app can say why.
        if (result.status === 403) return save({ status: 'no-access', readOnly: true, deletedLocally: false, error: null });
        // 200, or 410 (already gone in the cloud): nothing left to sync.
      }
      // ponytail: the local project is assumed gone already (deletedLocally is a tombstone); the store has no project delete.
      store.deleteRow(projectId);
      return { ...row, status: 'synced', error: null };
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let next: GraphSnapshot;
      let remoteTitle: string;
      let remoteVersion: number;

      if (current.baseVersion === null && attempt === 0) {
        const local = store.readLocalGraph(projectId);
        if (!local) return save({ status: 'error', error: 'This map is missing on this device.' });
        if ((await cloud.upsertProject(projectId, local.title)).status === 403) return save({ status: 'error', error: ID_TAKEN });
        next = local;
        remoteTitle = local.title;
        remoteVersion = 0;
      } else {
        const remote = await cloud.getGraph(projectId);
        if (remote.status !== 200) {
          if (remote.status === 403) return save({ readOnly: true, status: 'no-access', error: null });
          return save({ status: 'conflicts', conflicts: [projectConflict(projectId, 'deleted-remote')], error: null }); // 410
        }

        // A missing base (never pushed, or damaged) merges as if both sides added everything: same → kept, different → conflict.
        const base = current.baseGraph ?? { title: remote.graph.title, nodes: [], relationships: [] };
        // Read local only now, so read → merge → write runs with no await in between and can't lose an autosave.
        const local = store.readLocalGraph(projectId);
        if (!local || unchanged(local, base)) {
          // Nothing changed here: take the cloud (a no-op when it hasn't changed either).
          if (!local || !unchanged(local, remote.graph)) store.writeLocalGraph(projectId, remote.graph);
          return save({ baseGraph: remote.graph, baseVersion: remote.version, status: 'synced', error: null, lastSyncedAt: Date.now() });
        }

        const { merged, conflicts } = mergeGraphs(base, local, remote.graph);
        // Local now holds the cloud's changes, so the cloud graph is the new base (R17), in the same synchronous
        // block as the write. Otherwise a later merge would count those changes as local edits and push them back
        // over newer cloud changes. Conflicted items keep their local side in `merged`, so a choice made against
        // this base still diffs correctly: "mine" differs from it, "cloud" equals it.
        if (!unchanged(merged, local)) store.writeLocalGraph(projectId, merged);
        save({ baseGraph: remote.graph, baseVersion: remote.version, status: conflicts.length ? 'conflicts' : 'pending', conflicts, error: null });
        if (conflicts.length) return current;
        next = merged;
        remoteTitle = remote.graph.title;
        remoteVersion = remote.version;
      }

      let note: string | null = null;
      const files = referencedLocalFiles(store, projectId, next);
      if (files.length) {
        if (fileSync === undefined) fileSync = (await cloud.listProjects()).fileSync;
        if (fileSync) {
          let cloudUrls: Map<string, string>;
          try {
            cloudUrls = await uploadFiles(cloud, projectId, files);
          } catch {
            return save({ status: 'error', error: 'Could not upload a file.' });
          }
          next = rewriteFileUrls(next, cloudUrls);
          // Rewrite a fresh read, not `next`: edits saved during the upload stay (and push next time).
          const fresh = store.readLocalGraph(projectId);
          if (fresh) store.writeLocalGraph(projectId, rewriteFileUrls(fresh, cloudUrls));
          for (const url of files) store.removeLocalFile(url);
        } else {
          note = 'Files stay on this device: cloud file storage is off.';
        }
      }

      if (next.title !== remoteTitle && (await cloud.upsertProject(projectId, next.title)).status === 403) { // PUT /api/graph carries no title
        return save({ status: 'error', error: ID_TAKEN });
      }
      const result = await cloud.putGraph(projectId, next, remoteVersion);
      if (result.status === 409) continue; // someone saved in between: fetch again and re-merge
      if (result.status !== 200) return save({ status: 'error', error: result.error });
      return save({ baseGraph: next, baseVersion: result.version, status: 'synced', conflicts: [], error: note, lastSyncedAt: Date.now() });
    }
    return save({ status: 'error', error: 'The map kept changing in the cloud. Sync again in a moment.' });
  } catch (error) {
    if (isTokenRejected(error)) return current; // an account problem, not this map's: GET /api/sync reports it
    return save({ status: 'error', error: UNREACHABLE });
  }
}

/**
 * Runs `fn` once nothing else holds this map, and holds it meanwhile. Delete, remove, set-offline and repair use it,
 * so a running pass can't write a stale map or row back over them, and no pass starts halfway through one.
 */
export async function withProjectLock<T>(projectId: string, fn: () => T | Promise<T>, pass = false): Promise<T> {
  for (let held = locks.get(projectId); held; held = locks.get(projectId)) await held.run.catch(() => {});
  const run = (async () => fn())().finally(() => locks.delete(projectId));
  locks.set(projectId, { run, pass });
  return run;
}

/** One map, under the per-map lock: a second caller gets the running sync's result. */
export function syncProject(store: Store, cloud: CloudClient, projectId: string, fileSync?: boolean): Promise<SyncRow> {
  const held = locks.get(projectId);
  if (held?.pass) return held.run as Promise<SyncRow>;
  return withProjectLock(projectId, () => syncLocked(store, cloud, projectId, fileSync), true);
}

/** Every map of the connected account, one after another. */
export async function syncAll(store: Store, cloud: CloudClient): Promise<SyncRow[]> {
  const account = store.getAccount();
  if (!account) return store.listRows();
  const rows = store.listRows().filter(row => eligible(row, account.userId));

  let fileSync: boolean;
  try {
    ({ fileSync } = await cloud.listProjects());
  } catch (error) {
    if (isTokenRejected(error)) return store.listRows(); // the desktop must reconnect; the rows are fine
    for (const row of rows) store.saveRow({ ...row, status: 'error', error: UNREACHABLE });
    return store.listRows();
  }
  for (const row of rows) {
    // A map deleted or removed from this device meanwhile has no row left: nothing to sync.
    await syncProject(store, cloud, row.projectId, fileSync).catch(error => { if (store.getRow(row.projectId)) throw error; });
  }
  return store.listRows();
}
