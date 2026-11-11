'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { canRepair } from '@/lib/sync/ui';
import type { DesktopSync } from './useDesktopSync';

// Desktop-only pieces around the sync hook: the connect dialog, the read-only banner and the maps manager section.

type MapRef = { id: string; title: string };

/** Escape runs `onEscape` while `open`. */
function useEscape(open: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onEscape(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onEscape]);
}

/** R13/R19: the shell posted `connect`; the user confirms here, then picks the local maps to upload. */
export function ConnectDialog({ sync }: { sync: DesktopSync }) {
  const [upload, setUpload] = useState<MapRef[] | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const open = Boolean(upload || sync.pending);

  const finish = async () => { setUpload(null); await sync.syncNow(); };
  const cancel = async () => {
    if (busy) return;
    if (upload) { await finish(); return; }
    setBusy(true);
    await sync.act({ action: 'cancel-connect' }); // R25: a connected account stays connected
    await sync.refresh();
    setBusy(false);
  };
  const connect = async () => {
    setBusy(true);
    const data = await sync.act({ action: 'confirm-connect' });
    await sync.refresh();
    setBusy(false);
    if (!data) return;
    const local = Array.isArray(data.localOnly) ? data.localOnly as MapRef[] : [];
    if (local.length) { setUpload(local); setTicked(local.map(m => m.id)); } else await finish();
  };
  const uploadTicked = async () => {
    setBusy(true);
    if (ticked.length) await sync.act({ action: 'upload-local', projectIds: ticked });
    setBusy(false);
    await finish();
  };
  useEscape(open, () => void cancel());
  if (!open) return null;

  const who = sync.pending?.account.email || sync.pending?.account.name || 'your account';
  return (
    <div className="modal-scrim" role="presentation">
      <section className="work-modal sync-dialog" role="dialog" aria-modal="true" aria-labelledby="sync-dialog-title">
        {upload ? <>
          <h2 id="sync-dialog-title">Upload these maps to your account?</h2>
          <ul className="sync-upload-list">
            {upload.map(map => (
              <li key={map.id}>
                <label>
                  <input type="checkbox" checked={ticked.includes(map.id)} onChange={event => setTicked(current => event.target.checked ? [...current, map.id] : current.filter(id => id !== map.id))} />
                  {map.title || 'Untitled map'}
                </label>
              </li>
            ))}
          </ul>
          <div className="sync-dialog-actions">
            <button type="button" className="line-button" onClick={() => void finish()} disabled={busy}>Not now</button>
            <button type="button" className="ink-button" onClick={() => void uploadTicked()} disabled={busy} autoFocus>Upload</button>
          </div>
        </> : <>
          <h2 id="sync-dialog-title">{`Connect this desktop to ${who}?`}</h2>
          <p className="note-meta">Your maps sync with that account whenever this computer is online.</p>
          <div className="sync-dialog-actions">
            <button type="button" className="line-button" onClick={() => void cancel()} disabled={busy}>Cancel</button>
            <button type="button" className="ink-button" onClick={() => void connect()} disabled={busy} autoFocus>Connect</button>
          </div>
        </>}
      </section>
    </div>
  );
}

export function ReadOnlyBanner({ onExport, onRemove }: { onExport: () => void; onRemove: () => void }) {
  return (
    <div className="sync-banner" role="alert">
      <span>You no longer have access to this map.</span>
      <div>
        <button type="button" className="line-button" onClick={onExport}>Export</button>
        <button type="button" className="line-button" onClick={onRemove}>Remove from this device</button>
      </div>
    </div>
  );
}

/** Per-map sync controls for the maps manager rows (MapMenu `extraActions`). */
export function mapSyncActions(sync: DesktopSync, handlers: {
  onRemove: (id: string, title: string) => void;
  onResolve: (id: string) => void;
  onChanged: () => void;
}) {
  const after = async (body: object) => { if (await sync.act(body)) await sync.syncNow(); handlers.onChanged(); };
  return function mapActions(map: MapRef): ReactNode {
    const row = sync.rows.find(r => r.projectId === map.id);
    const title = map.title || 'Untitled map';
    if (!row) {
      return sync.account
        ? <button type="button" className="map-menu-action" onClick={() => void after({ action: 'upload-local', projectIds: [map.id] })}>Upload to your account</button>
        : null;
    }
    return <>
      {sync.account && (
        <label className="map-menu-action">
          <input type="checkbox" checked={row.offline} onChange={event => void after({ action: 'set-offline', projectId: map.id, offline: event.target.checked })} />
          Available offline
        </label>
      )}
      {row.conflicts.length > 0 && <button type="button" className="map-menu-action" onClick={() => handlers.onResolve(map.id)}>Resolve conflicts</button>}
      {canRepair(row) && <button type="button" className="map-menu-action" onClick={() => void after({ action: 'repair', projectId: map.id })}>Repair sync</button>}
      <button type="button" className="map-menu-action is-danger" onClick={() => handlers.onRemove(map.id, title)}>Remove from this device</button>
    </>;
  };
}

/** A short status beside a map's name (MapMenu `badgeFor`). */
export function mapSyncBadge(sync: DesktopSync) {
  return (id: string): string | null => {
    const row = sync.rows.find(r => r.projectId === id);
    return row?.status === 'conflicts' ? 'Conflicts' : row?.status === 'error' ? 'Sync error' : null;
  };
}

/** The maps manager's cloud section: account, online-only maps, and maps deleted here that changed in the cloud. */
export function DesktopMapsSection({ sync, localIds, onResolve, onChanged }: {
  sync: DesktopSync;
  localIds: string[];
  onResolve: (id: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const tracked = new Set(sync.rows.map(r => r.projectId));
  const onlineOnly = sync.cloudProjects.filter(p => !tracked.has(p.id) && !localIds.includes(p.id));
  const deletedHere = sync.rows.filter(r => r.deletedLocally && r.conflicts.length > 0);
  const titleOf = (id: string) => sync.cloudProjects.find(p => p.id === id)?.title || 'A map';
  const run = async (body: object) => {
    setBusy(true);
    const ok = await sync.act(body);
    await sync.refresh();
    setBusy(false);
    if (ok) onChanged();
  };

  return (
    <section className="sync-maps" aria-label="Cloud sync">
      {sync.account ? (
        <p className="sync-maps-account">
          <span>{sync.needsReconnect ? 'Signed out of' : 'Synced with'} {sync.account.email || sync.account.name || 'your account'}</span>
          {sync.needsReconnect && sync.cloudUrl && <button type="button" className="text-button" onClick={() => window.open(`${sync.cloudUrl}/desktop/connect`)}>Reconnect this desktop</button>}
          <button type="button" className="text-button" disabled={busy} onClick={() => void run({ action: 'disconnect' })}>Disconnect</button>
        </p>
      ) : sync.cloudUrl ? (
        <button type="button" className="line-button" onClick={() => window.open(`${sync.cloudUrl}/desktop/connect`)}>Connect account</button>
      ) : (
        <p className="note-meta">Cloud sync isn&apos;t set up for this app.</p>
      )}

      {onlineOnly.length > 0 && <>
        <p className="map-menu-heading"><span>In your account</span><small>{onlineOnly.length}</small></p>
        <ul className="map-menu-list">
          {onlineOnly.map(p => (
            <li key={p.id} className="map-menu-row sync-online-only">
              <span className="map-menu-name">{p.title || 'Untitled map'}</span>
              <span className="map-menu-badge">Online only</span>
              <label className="text-button">
                <input type="checkbox" checked={false} disabled={busy || !sync.online} onChange={() => void run({ action: 'set-offline', projectId: p.id, offline: true })} />
                Available offline
              </label>
            </li>
          ))}
        </ul>
      </>}

      {deletedHere.length > 0 && <ul className="map-menu-list">
        {deletedHere.map(r => (
          <li key={r.projectId} className="map-menu-row sync-online-only">
            <span className="map-menu-name">{titleOf(r.projectId)}</span>
            <span className="map-menu-badge">Deleted here</span>
            <button type="button" className="text-button" onClick={() => onResolve(r.projectId)}>Resolve conflicts</button>
          </li>
        ))}
      </ul>}
    </section>
  );
}
