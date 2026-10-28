import { randomUUID } from 'crypto';
import { getServerAuth } from '@/lib/auth';
import { deleteProjectFromDb, getProjectsFromDb, projectExistsInDb } from '@/lib/db';
import { syncGraphVectors } from '@/lib/rag/vector-store';
import { CloudError, createCloudClient } from '@/lib/sync/cloud-client';
import { syncAll, syncProject } from '@/lib/sync/engine';
import { applyResolution, type ResolutionChoice } from '@/lib/sync/resolve';
import { syncStore, type SyncAccount, type SyncRow } from '@/lib/sync/store';

// Desktop only: the local server's sync controls for the desktop UI and the Electron shell.
// The device token lives in the local database and in memory; it is never logged or returned.

const notFound = () => Response.json({ error: 'Not found.' }, { status: 404 });
const bad = (error: string, status = 400) => Response.json({ error }, { status });
const isDesktop = () => process.env.SYNTHEX_DESKTOP === '1';
const cloudUrl = () => (process.env.SYNTHEX_CLOUD_URL || '').trim().replace(/\/+$/, '');

const CHOICES: ResolutionChoice[] = ['mine', 'cloud', 'both', 'keep', 'delete'];
const PENDING_MS = 10 * 60 * 1000;

const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 80;
const validToken = (v: unknown): v is string => typeof v === 'string' && v.startsWith('sxd_') && v.length <= 200 && /^[\x21-\x7e]+$/.test(v);

// R19: a verified token waits here (never on disk) until the user confirms, for at most 10 minutes.
let pending: {
  token: string; userId: string; cloudUrl: string; account: { email: string | null; name: string | null };
  timer: ReturnType<typeof setTimeout>;
} | null = null;
function clearPending() {
  if (pending) clearTimeout(pending.timer);
  pending = null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- baseGraph is dropped from responses
const publicRows = () => syncStore.listRows().map(({ baseGraph, ...row }) => row);

/** The connected account, only while a cloud URL is configured. */
function connectedAccount(): SyncAccount | null {
  return cloudUrl() ? syncStore.getAccount() : null;
}

async function localAuth() {
  const auth = await getServerAuth();
  return { userId: auth.user?.id || auth.userId, clerkId: auth.clerkId };
}

/** Local maps with no sync row: the "upload these?" list. */
async function localOnly() {
  const { userId, clerkId } = await localAuth();
  const tracked = new Set(syncStore.listRows().map(r => r.projectId));
  return (await getProjectsFromDb(userId, null, clerkId)).filter(p => !tracked.has(p.id)).map(({ id, title }) => ({ id, title }));
}

/** The normal local delete path (as DELETE /api/projects), plus the map's local-file records. */
async function deleteLocalProject(projectId: string) {
  const { userId, clerkId } = await localAuth();
  await deleteProjectFromDb(projectId, userId, clerkId);
  for (const url of syncStore.listLocalFiles(projectId)) syncStore.removeLocalFile(url);
  try {
    await syncGraphVectors(projectId, []);
  } catch (error) {
    console.warn('Could not clear the search index of a deleted map:', error);
  }
}

const newRow = (projectId: string, accountId: string, baseVersion: number | null): SyncRow => ({
  projectId, accountId, offline: true, baseGraph: null, baseVersion, status: 'pending', conflicts: [],
  error: null, readOnly: false, deletedLocally: false, lastSyncedAt: null
});

// R23: destroying a local copy that may hold work the cloud doesn't have needs an explicit `confirm: true`.
const needsConfirm = (row: SyncRow | null) => !row || row.status !== 'synced' || row.baseVersion === null;
const unsynced = () => Response.json({ error: 'This map has changes that are not in the cloud.', unsynced: true }, { status: 409 });

export async function GET() {
  if (!isDesktop()) return notFound();
  try {
    const account = connectedAccount();
    let online = false;
    let profile: { email: string | null; name: string | null } = { email: null, name: null };
    let cloudProjects: { id: string; title: string; version: number }[] = [];
    if (account) {
      try {
        const list = await createCloudClient(account, 3000).listProjects();
        online = true;
        profile = list.account;
        cloudProjects = list.projects;
      } catch {
        // offline: report it, never fail the status call
      }
    }
    return Response.json({
      account: account ? { userId: account.userId, cloudUrl: account.cloudUrl, ...profile } : null,
      cloudUrl: cloudUrl() || null,
      // A sign-in waiting for the user's yes (never the token).
      pending: pending && pending.cloudUrl === cloudUrl() ? { account: pending.account } : null,
      online,
      rows: publicRows(),
      cloudProjects
    });
  } catch (error) {
    console.error('Failed to read sync status:', error instanceof Error ? error.message : error);
    return bad('Could not read the sync status.', 500);
  }
}

export async function POST(request: Request) {
  if (!isDesktop()) return notFound();
  // JSON only: a cross-site page can't send this content type without a CORS preflight, which this route never grants.
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) return bad('Expected JSON.', 415);
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return bad('Expected a JSON body.');
  const input = body as Record<string, unknown>;
  const action = input.action;

  try {
    switch (action) {
      case 'connect': {
        const url = cloudUrl();
        if (!url) return bad('No cloud is configured for this desktop app.');
        if (!validToken(input.token)) return bad('That is not a desktop token.');
        let list;
        try {
          list = await createCloudClient({ token: input.token, cloudUrl: url }).listProjects();
        } catch (error) {
          // An unknown or revoked token reads as signed out: the device route answers 404 (or 401/403 upstream).
          if (error instanceof CloudError && [401, 403, 404].includes(error.status)) return bad('The cloud did not accept that token.');
          console.warn('Connect failed:', error instanceof Error ? error.message : error);
          return bad('Could not reach the cloud.', 502);
        }
        clearPending();
        pending = { token: input.token, userId: list.userId, cloudUrl: url, account: list.account, timer: setTimeout(clearPending, PENDING_MS) };
        pending.timer.unref?.();
        return Response.json({ account: list.account, userId: list.userId, localOnly: await localOnly() });
      }

      case 'confirm-connect': {
        if (!pending || pending.cloudUrl !== cloudUrl()) return bad('Connect again: that sign-in expired.');
        const { token, userId, cloudUrl: url } = pending;
        clearPending();
        // Rows of a previously connected account stay; the engine only syncs rows of this userId.
        syncStore.setAccount({ token, userId, cloudUrl: url, connectedAt: Date.now() });
        return Response.json({ userId, localOnly: await localOnly(), rows: publicRows() });
      }

      case 'disconnect': {
        clearPending();
        syncStore.setAccount(null);
        return Response.json({ rows: publicRows() });
      }

      case 'upload-local': {
        const account = connectedAccount();
        if (!account) return bad('Connect to the cloud first.');
        const ids = input.projectIds;
        if (!Array.isArray(ids) || ids.length > 1000 || !ids.every(validId)) return bad('Choose the maps to upload.');
        for (const id of ids) {
          if (syncStore.getRow(id) || !(await projectExistsInDb(id))) continue; // already tracked, or not on this device
          syncStore.saveRow(newRow(id, account.userId, null));
        }
        return Response.json({ rows: publicRows() });
      }

      case 'set-offline': {
        const account = connectedAccount();
        if (!account) return bad('Connect to the cloud first.');
        const { projectId, offline } = input;
        if (!validId(projectId) || typeof offline !== 'boolean') return bad('Choose a map and whether to keep it offline.');
        const row = syncStore.getRow(projectId);
        if (row) {
          if (row.accountId && row.accountId !== account.userId) return bad('This map belongs to another cloud account.', 409);
          syncStore.saveRow({ ...row, offline, accountId: account.userId });
        } else if (offline) {
          // A cloud map not on this device yet: track it at the cloud's version with no base, and pull it.
          const cloud = createCloudClient(account);
          const project = (await cloud.listProjects()).projects.find(p => p.id === projectId);
          if (!project) return bad('That map is not in the cloud.', 404);
          if (await projectExistsInDb(projectId)) return bad('A map with that id is already on this device.', 409);
          syncStore.saveRow(newRow(projectId, account.userId, project.version));
          await syncProject(syncStore, cloud, projectId);
        }
        return Response.json({ rows: publicRows() });
      }

      case 'sync': {
        const account = connectedAccount();
        if (!account) return bad('Connect to the cloud first.');
        const { projectId } = input;
        const cloud = createCloudClient(account);
        if (projectId === undefined) await syncAll(syncStore, cloud);
        else if (!validId(projectId)) return bad('Choose a map to sync.');
        else if (!syncStore.getRow(projectId)) return bad('That map is not synced.', 404);
        else await syncProject(syncStore, cloud, projectId);
        return Response.json({ rows: publicRows() });
      }

      case 'resolve': {
        const { projectId, conflictId, choice } = input;
        if (!validId(projectId) || typeof conflictId !== 'string' || conflictId.length > 300 ||
          typeof choice !== 'string' || !CHOICES.includes(choice as ResolutionChoice)) {
          return bad('Choose a conflict and how to resolve it.');
        }
        const row = syncStore.getRow(projectId);
        const conflict = row?.conflicts.find(c => c.id === conflictId);
        if (!row || !conflict) return bad('That conflict is already resolved.', 404);
        const remaining = row.conflicts.filter(c => c.id !== conflictId);
        const account = connectedAccount();

        if (conflict.kind === 'project') {
          if (choice !== 'keep' && choice !== 'delete') return bad('Choose keep or delete for this map.');
          const cleared: SyncRow = { ...row, conflicts: remaining, status: 'pending', error: null };
          if (conflict.reason === 'deleted-remote' && choice === 'keep') {
            syncStore.saveRow({ ...cleared, baseVersion: null, baseGraph: null }); // re-created in the cloud next pass
          } else if (conflict.reason === 'deleted-remote') {
            await deleteLocalProject(projectId);
            syncStore.deleteRow(projectId);
            return Response.json({ rows: publicRows() });
          } else if (choice === 'keep') {
            // Row exists, local copy is gone, baseVersion is set: the next pass pulls the cloud map back.
            syncStore.saveRow({ ...cleared, deletedLocally: false, baseGraph: null });
          } else {
            if (!account) return bad('Connect to the cloud first.');
            const cloud = createCloudClient(account);
            const remote = await cloud.getGraph(projectId);
            const result = remote.status === 200 ? await cloud.deleteProject(projectId, remote.version) : remote;
            if (result.status === 409) return bad('The map changed in the cloud again. Try once more.', 409);
            if (result.status === 403) {
              syncStore.saveRow({ ...cleared, status: 'no-access', readOnly: true, deletedLocally: false });
            } else {
              syncStore.deleteRow(projectId); // 200, or 410: already gone
            }
            return Response.json({ rows: publicRows() });
          }
        } else {
          // Read, apply and write with no await in between, so an autosave can't land in the middle.
          const local = syncStore.readLocalGraph(projectId);
          if (!local) return bad('This map is missing on this device.', 409);
          let next;
          try {
            next = applyResolution(local, conflict, choice as ResolutionChoice, () => randomUUID());
          } catch (error) {
            return bad(error instanceof Error ? error.message : 'That choice does not fit this conflict.');
          }
          syncStore.writeLocalGraph(projectId, next);
          syncStore.saveRow({ ...row, conflicts: remaining, status: remaining.length ? 'conflicts' : 'pending' });
        }
        if (!remaining.length && account) await syncProject(syncStore, createCloudClient(account), projectId);
        return Response.json({ rows: publicRows() });
      }

      case 'delete-local': {
        const { projectId } = input;
        if (!validId(projectId)) return bad('Choose a map to delete.');
        const row = syncStore.getRow(projectId);
        if (needsConfirm(row) && input.confirm !== true) return unsynced();
        await deleteLocalProject(projectId);
        // Pushed before: keep a tombstone so the next sync deletes it in the cloud too.
        // Its open conflicts go with the local copy.
        if (row && row.baseVersion !== null) syncStore.saveRow({ ...row, deletedLocally: true, conflicts: [], status: 'pending', error: null });
        else syncStore.deleteRow(projectId);
        return Response.json({ rows: publicRows() });
      }

      case 'remove-from-device': {
        const { projectId } = input;
        if (!validId(projectId)) return bad('Choose a map to remove.');
        if (needsConfirm(syncStore.getRow(projectId)) && input.confirm !== true) return unsynced();
        await deleteLocalProject(projectId);
        syncStore.deleteRow(projectId);
        return Response.json({ rows: publicRows() });
      }

      case 'repair': {
        const { projectId } = input;
        if (!validId(projectId)) return bad('Choose a map to repair.');
        const row = syncStore.getRow(projectId);
        if (!row) return bad('That map is not synced.', 404);
        syncStore.saveRow({ ...row, conflicts: [], error: null, baseGraph: null, status: 'pending' });
        return Response.json({ rows: publicRows() });
      }

      default:
        return bad('Unknown action.');
    }
  } catch (error) {
    // CloudError and db messages never carry the token.
    console.error(`Sync action "${String(action).slice(0, 40)}" failed:`, error instanceof Error ? error.message : error);
    return bad('Could not complete that sync action.', 500);
  }
}
