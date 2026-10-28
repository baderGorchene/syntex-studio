'use client';

import { canRepair, syncLabel } from '@/lib/sync/ui';
import type { DesktopSync } from './useDesktopSync';

/** Topbar chip for the open map on desktop: Offline · Synced · Syncing · Conflicts · Sync error, and Sync now. */
export function SyncStatusChip({ sync, onOpenConflicts }: { sync: DesktopSync; onOpenConflicts: () => void }) {
  const { row } = sync;
  if (!sync.enabled || !sync.account || (!row && !sync.appOffline)) return null;
  const label = syncLabel(row, sync.appOffline, sync.syncing);
  const detail = label !== 'Sync error' ? null : row?.status === 'no-access' ? 'You no longer have access to this map.' : row?.error;
  const repair = async () => {
    if (row && await sync.act({ action: 'repair', projectId: row.projectId })) await sync.syncNow();
  };

  return (
    <span className={`sync-chip is-${label.toLowerCase().replace(' ', '-')}`}>
      {label === 'Conflicts'
        ? <button type="button" className="topbar-conflicts" onClick={onOpenConflicts}>Conflicts</button>
        : <span role="status" title={detail || undefined}>{label}</span>}
      {detail && <small className="sync-chip-detail">{detail}</small>}
      {canRepair(row) && <button type="button" className="text-button" onClick={() => void repair()}>Repair sync</button>}
      <button type="button" className="text-button" onClick={() => void sync.syncNow()} disabled={sync.syncing}>Sync now</button>
    </span>
  );
}
