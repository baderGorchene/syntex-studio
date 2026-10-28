import type { SyncRow } from './store.ts';

// Pure decisions behind the desktop sync UI (type-strippable, so tests can import it).

export const DAMAGED = 'Stored sync data is damaged.';
export type SyncLabel = 'Reconnect' | 'Offline' | 'Synced' | 'Syncing' | 'Conflicts' | 'Sync error';

type RowState = Pick<SyncRow, 'status' | 'offline' | 'readOnly' | 'error'>;

/**
 * The chip's word for the open map. `appOffline`: connected, but the cloud can't be reached.
 * `needsReconnect`: the cloud answered, but no longer accepts this desktop's token.
 */
export function syncLabel(row: RowState | null, appOffline: boolean, syncing: boolean, needsReconnect = false): SyncLabel {
  if (needsReconnect) return 'Reconnect';
  if (appOffline) return 'Offline';
  if (syncing || row?.status === 'pending') return 'Syncing';
  if (row?.status === 'conflicts') return 'Conflicts';
  if (row?.status === 'error' || row?.status === 'no-access') return 'Sync error';
  return 'Synced';
}

/** Edits are refused: access was lost, or the map lives in the cloud and the cloud is unreachable. */
export function isMapReadOnly(row: RowState | null, appOffline: boolean): boolean {
  return Boolean(row && (row.readOnly || (!row.offline && appOffline)));
}

/** Rows that may hold work the cloud doesn't have: warn before deleting or removing them. */
export function needsUnsyncedWarning(row: RowState | null): boolean {
  return Boolean(row && (row.status === 'pending' || row.status === 'conflicts' || row.status === 'error'));
}

export function canRepair(row: RowState | null): boolean {
  return row?.status === 'error' && row.error === DAMAGED;
}
