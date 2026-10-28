'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SyncRow } from '@/lib/sync/store';
import { needsUnsyncedWarning } from '@/lib/sync/ui';

// Desktop only: polls the local server's /api/sync. On web that route answers 404, and this hook stays inert.

export type PublicRow = Omit<SyncRow, 'baseGraph'>;
export interface SyncAccountInfo { userId: string; cloudUrl: string; email: string | null; name: string | null }
export interface CloudProject { id: string; title: string; version: number }
interface Status {
  account: SyncAccountInfo | null;
  cloudUrl: string | null;
  pending: { account: { email: string | null; name: string | null } } | null;
  online: boolean;
  rows: PublicRow[];
  cloudProjects: CloudProject[];
}
type ActResult = Record<string, unknown> & { rows?: PublicRow[]; unsynced?: boolean };

const POLL_MS = 60_000;
const AFTER_SAVE_MS = 5_000;
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const EMPTY: Status = { account: null, cloudUrl: null, pending: null, online: false, rows: [], cloudProjects: [] };

export function useDesktopSync(projectId: string | null, announce: (message: string) => void) {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<Status>(EMPTY);
  const [syncing, setSyncing] = useState(false);
  const alive = useRef(true);
  const disabled = useRef(false);
  const seenDesktop = useRef(false); // until the first good answer, failures stay silent (web must look unchanged)
  const statusRef = useRef(status);
  const announceRef = useRef(announce);
  useEffect(() => { statusRef.current = status; announceRef.current = announce; });
  const getInFlight = useRef<Promise<void> | null>(null);
  const syncInFlight = useRef<Promise<void> | null>(null);
  const afterSave = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** GET /api/sync; one at a time (a second caller shares the running request). */
  const refresh = useCallback((): Promise<void> => {
    if (disabled.current) return Promise.resolve();
    getInFlight.current ??= (async () => {
      try {
        const response = await fetch('/api/sync', { cache: 'no-store', headers: JSON_HEADERS });
        if (response.status === 404) { disabled.current = true; return; } // web: no desktop sync
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error);
        if (!alive.current) return;
        statusRef.current = { ...EMPTY, ...data }; // read right away by syncNow, before the re-render
        setStatus(statusRef.current);
        seenDesktop.current = true;
        setEnabled(true);
      } catch (error) {
        if (alive.current && seenDesktop.current) announceRef.current(error instanceof Error && error.message ? error.message : 'Could not read the sync status.');
      } finally {
        getInFlight.current = null;
      }
    })();
    return getInFlight.current;
  }, []);

  /** POST an action. Returns the body, `{ unsynced: true }` for R23's 409, or null after announcing the failure. */
  const act = useCallback(async (body: object): Promise<ActResult | null> => {
    try {
      const response = await fetch('/api/sync', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
      const data = (await response.json().catch(() => ({}))) as ActResult;
      if (response.status === 409 && data.unsynced) return { unsynced: true };
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '');
      const action = (body as { action?: unknown }).action;
      const settled = action === 'confirm-connect' || action === 'cancel-connect' || action === 'disconnect'; // the waiting sign-in is gone either way
      if (alive.current && (Array.isArray(data.rows) || settled)) {
        setStatus(current => ({ ...current, rows: data.rows ?? current.rows, pending: settled ? null : current.pending }));
      }
      return data;
    } catch (error) {
      if (alive.current) announceRef.current(error instanceof Error && error.message ? error.message : 'Could not complete that sync action.');
      return null;
    }
  }, []);

  /** One sync pass over every map, then a fresh status. Never stacks: a second caller waits on the running pass. */
  const syncNow = useCallback((): Promise<void> => {
    if (!statusRef.current.account) return Promise.resolve();
    syncInFlight.current ??= (async () => {
      if (alive.current) setSyncing(true);
      try {
        await act({ action: 'sync' });
        await refresh();
      } finally {
        syncInFlight.current = null;
        if (alive.current) setSyncing(false);
      }
    })();
    return syncInFlight.current;
  }, [act, refresh]);

  /** Background passes skip when the cloud is unreachable, so they don't announce an error every few seconds. */
  const quietSync = useCallback(async () => {
    await refresh();
    if (statusRef.current.account && statusRef.current.online) await syncNow();
  }, [refresh, syncNow]);

  /** Debounced: a sync pass 5 s after the last autosave. */
  const scheduleSync = useCallback(() => {
    if (disabled.current || !statusRef.current.account) return;
    if (afterSave.current) clearTimeout(afterSave.current);
    afterSave.current = setTimeout(() => { afterSave.current = null; void quietSync(); }, AFTER_SAVE_MS);
  }, [quietSync]);

  useEffect(() => {
    alive.current = true;
    void quietSync();
    const timer = setInterval(() => { if (!disabled.current) void quietSync(); }, POLL_MS);
    const onOnline = () => { if (!disabled.current) void quietSync(); };
    // Back from the system browser: pick up a waiting sign-in at once (refresh reuses a running request).
    const onFocus = () => { if (!disabled.current) void refresh(); };
    const onVisible = () => { if (document.visibilityState === 'visible') onFocus(); };
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      clearInterval(timer);
      if (afterSave.current) clearTimeout(afterSave.current);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [quietSync, refresh]);

  /**
   * R23: delete-local or remove-from-device. Warns up front for rows with unsynced work, and again if the server
   * says the map isn't fully synced; `confirm: true` goes only after the user agrees. Resolves true when done.
   */
  const destroy = useCallback(async (action: 'delete-local' | 'remove-from-device', id: string, title: string) => {
    const row = statusRef.current.rows.find(r => r.projectId === id) ?? null;
    const warning = `“${title}” has changes that aren't in the cloud yet. ${action === 'delete-local' ? 'Delete it' : 'Remove it from this device'} anyway? Those changes will be lost.`;
    // A map with no row was never uploaded: the delete confirmation the user just passed already covers it.
    let confirmed = !row && action === 'delete-local';
    if (needsUnsyncedWarning(row)) {
      if (!window.confirm(warning)) return false;
      confirmed = true;
    }
    let data = await act({ action, projectId: id, ...(confirmed ? { confirm: true } : {}) });
    if (data?.unsynced) {
      if (!window.confirm(warning)) return false;
      data = await act({ action, projectId: id, confirm: true });
    }
    return Boolean(data && !data.unsynced);
  }, [act]);

  const appOffline = Boolean(status.account) && !status.online;
  return {
    enabled,
    online: status.online,
    appOffline,
    syncing,
    account: status.account,
    cloudUrl: status.cloudUrl,
    pending: status.pending,
    rows: status.rows,
    row: (projectId && status.rows.find(r => r.projectId === projectId)) || null,
    cloudProjects: status.cloudProjects,
    refresh,
    syncNow,
    scheduleSync,
    act,
    destroy
  };
}

export type DesktopSync = ReturnType<typeof useDesktopSync>;
