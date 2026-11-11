# Desktop App with Offline Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows desktop build of Synthex Studio that edits chosen personal maps offline and syncs them with the cloud using a three-way merge, with conflicts resolved by the user.

**Architecture:** Electron starts the existing Next standalone server locally (SQLite, local mode, AI off). A pure `mergeGraphs(base, local, remote)` in `src/lib/sync/` is shared by the desktop sync engine and the web autosave. The cloud gets a per-project `graphVersion` (optimistic concurrency, 409 on mismatch) and device tokens, so the desktop's local server can call the cloud server-to-server.

**Tech Stack:** Next 16.3 / React 19.2, better-sqlite3, Neon, Clerk, Electron + electron-builder (NSIS), `@electron/rebuild`, `node:test` with type stripping.

**Spec:** `docs/superpowers/specs/2026-10-28-desktop-offline-sync-design.md`

## Global Constraints

- One codebase. With no `SYNTHEX_*` env vars set, Vercel and Cloud Run behave exactly as today.
- Desktop env vars: `SYNTHEX_DESKTOP=1`, `SYNTHEX_DATA_DIR`, `SYNTHEX_UPLOAD_DIR`, `SYNTHEX_CLOUD_URL`. Set only by `electron/main.cjs`.
- Cloud schema changes go in three places: `db.ts` (`ensureSchemaColumns`), `neon.ts` auto-init, and `scripts/schema-postgres.sql`. Desktop-only tables (`sync_state`, `sync_account`, `local_files`) are SQLite-only, because the desktop never runs on Neon.
- Modules under `src/lib/sync/` that tests import use `.ts` relative imports and no enums or parameter properties.
- No cloud API keys and no Neon URL ship in the installer. Device tokens are stored hashed (SHA-256) on the cloud, never logged, and appear in a URL only in the `synthex://connect` handoff.
- Layout fields that never conflict: `x`, `y`, `width`, `height`, `metadata.collapsed`. `sectionId` is merged as its own field.
- Conflict copy title suffix: ` (conflict copy)`.
- Status values: `synced | pending | conflicts | error | no-access`.
- 5xx responses return generic messages. The real error is logged on the server.
- `ELECTRON_SKIP_BINARY_DOWNLOAD=1` must be set on Vercel (record it in `.env.example` with a comment).

## Review Focus

1. **Same note edited on desktop (offline) and on web.** Expected: a conflict, never a silent overwrite. Covered in Task 2 (`conflicts when both sides change content`).
2. **Network drops during a push.** Expected: the base is not advanced, local edits are kept, and the next pass retries cleanly. Covered in Task 8 (`push failure keeps base and local`).
3. **A stale browser tab saves after the desktop pushed.** Expected: 409, then a merge that keeps the desktop's changes. Covered in Task 3 (`stale baseVersion is rejected`) and Task 4 (manual check).
4. **The push is rejected as too large (413) after a long offline session.** Expected: status `error` with a readable message, and local data untouched. Covered in Task 8 (`413 marks error and keeps data`).
5. **Two sync passes at once** (timer plus the Sync button). Expected: one push per project. Covered in Task 8 (`concurrent syncs push once`).

---

### Task 1: Configurable data and upload directories

**Files:**
- Modify: `src/lib/db.ts:68-84` (`getDbPath`)
- Modify: `src/app/api/upload/route.ts:79-80`
- Create: `src/app/api/local-files/[...path]/route.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: when `SYNTHEX_UPLOAD_DIR` is set, uploads are saved to `{SYNTHEX_UPLOAD_DIR}/{projectId}/{file}` and their URL is `/api/local-files/{projectId}/{file}`.

- [ ] **Step 1:** In `getDbPath()`, before the Vercel branch, return `path.join(process.env.SYNTHEX_DATA_DIR, 'canvas.db')` when the variable is set. Create the directory with `fs.mkdirSync(..., { recursive: true })`.
- [ ] **Step 2:** In the upload route's local-disk branch, use `SYNTHEX_UPLOAD_DIR` when it's set, and return the `/api/local-files/...` URL.
- [ ] **Step 3:** Create `GET /api/local-files/[...path]`. Return 404 unless `SYNTHEX_DESKTOP === '1'`. Resolve the path under `SYNTHEX_UPLOAD_DIR` and reject anything outside it (`path.relative` starting with `..`, or an absolute path) with 404. Stream the file with a content type from its extension.
- [ ] **Step 4:** Document all four `SYNTHEX_*` vars and `ELECTRON_SKIP_BINARY_DOWNLOAD` in `.env.example`.
- [ ] **Step 5: Verify:** run `SYNTHEX_DATA_DIR=./.tmp-desk SYNTHEX_UPLOAD_DIR=./.tmp-desk/uploads SYNTHEX_DESKTOP=1 npm run dev`. Expected: `.tmp-desk/canvas.db` is created. An image uploaded in `/app` loads from `/api/local-files/...`, and `/api/local-files/../canvas.db` returns 404. Run `npx tsc --noEmit` with no errors.
- [ ] **Step 6: Commit** `feat: configurable data and upload dirs for desktop builds`

### Task 2: Three-way graph merge

**Files:**
- Create: `src/lib/sync/merge.ts`
- Test: `tests/sync.test.mjs` (new), and add it to the `test` script: `node --experimental-strip-types --test tests/graph.test.mjs tests/sync.test.mjs`

**Interfaces:**
- Consumes: `CanvasNode` and `Connection` from `../../types/canvas.ts`, and `normalizeGraph` from `../graph.ts`.
- Produces:
```ts
export interface GraphSnapshot { title: string; nodes: CanvasNode[]; relationships: Connection[] }
export type ConflictReason = 'both-changed' | 'deleted-local' | 'deleted-remote';
export interface GraphConflict {
  id: string;                        // `${kind}:${itemId}` — stable for resolution
  kind: 'node' | 'edge' | 'title' | 'project';   // 'project' is created only by the engine (Task 8), never by mergeGraphs
  itemId: string;                    // node/edge id, or projectId for title/project
  reason: ConflictReason;
  base?: CanvasNode | Connection | string;
  local?: CanvasNode | Connection | string;
  remote?: CanvasNode | Connection | string;
}
export interface MergeResult { merged: GraphSnapshot; conflicts: GraphConflict[]; dropped: string[] }
export function mergeGraphs(base: GraphSnapshot, local: GraphSnapshot, remote: GraphSnapshot): MergeResult;
export function sameGraph(a: GraphSnapshot, b: GraphSnapshot): boolean;   // order-insensitive, key-order-insensitive
```

Rules, per node ID and edge ID (spec §5 table):
- **Nodes:** content is everything except the layout fields, `metadata.collapsed` and `sectionId`. Content and `sectionId` each merge three-way. When they differ on both sides, it's a `both-changed` conflict. Layout fields merge three-way per field, and local wins when both changed.
- **Deletes:** deleted on one side and content-changed on the other gives `deleted-local` or `deleted-remote`. A node deleted on one side while the other side **added** an edge to it is also `deleted-local` or `deleted-remote`, on the node.
- **While a conflict is open,** `merged` holds the local version, or no item when local deleted it.
- **Edges:** compared whole. Edges left dangling for any other reason go in `dropped` (as edge IDs) and are removed. The result passes `normalizeGraph`.
- **Title:** three-way. Different titles on both sides give a `title` conflict.

- [ ] **Step 1: Write failing tests** in `tests/sync.test.mjs`, with `node(id, extra)` and `edge(id, from, to)` helpers like those in `graph.test.mjs`:
  - `keeps additions from both sides`: base empty; local adds `a`, remote adds `b` → merged has `a` and `b`, no conflicts.
  - `takes one-sided edits`: local changes `a.title`; remote changes `b.content` → both applied, no conflicts.
  - `conflicts when both sides change content`: both change `a.content` differently → one conflict `{ id: 'node:a', reason: 'both-changed' }`, and merged `a` is the local one.
  - `identical edits on both sides are not a conflict`.
  - `layout never conflicts and local wins`: both move `a` (local `x: 10`, remote `x: 20`) → `x === 10`, no conflicts. Remote-only move → remote `x`.
  - `collapsing a section is layout`: local sets `metadata.collapsed = true` on section `s`; remote edits `s.title` → both applied, no conflicts.
  - `sectionId merges separately`: local changes `a.sectionId`; remote changes `a.content` → both applied. Both change `sectionId` differently → conflict.
  - `delete vs edit conflicts`: local deletes `a`, remote edits it → `reason: 'deleted-local'`, and `a` is absent from merged.
  - `delete vs new link conflicts on the node`: local deletes `a`, remote adds edge `e` (`b → a`) → conflict `node:a` with `deleted-local`, and `e` is not in `dropped`.
  - `drops edges left dangling by agreed deletes`: both delete `a`, and an edge `b → a` exists in base and local → removed. Since no conflict covers it, `dropped` lists that edge ID.
  - `title conflicts`: local title `L`, remote title `R`, base `B` → one `title` conflict.
  - `sameGraph ignores order`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL with `Cannot find module .../merge.ts`.
- [ ] **Step 3: Implement** `mergeGraphs` and `sameGraph` in `src/lib/sync/merge.ts`. Compare with a local `stableStringify` (sorted keys). Don't add a dependency.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: three-way graph merge for sync`

### Task 3: Conflict resolution and cloud graph versions

**Files:**
- Create: `src/lib/sync/resolve.ts`
- Modify: `src/lib/db.ts` (projects `graphVersion` column, `bulkSaveCanvasToDb`, new `getGraphVersion`)
- Modify: `src/lib/neon.ts` (`graph_version` column, `neonBulkSaveCanvas`, `neonGetGraphVersion`)
- Modify: `scripts/schema-postgres.sql`
- Modify: `src/app/api/graph/route.ts`
- Test: `tests/sync.test.mjs`

**Interfaces:**
- Consumes: `GraphSnapshot` and `GraphConflict` from Task 2.
- Produces:
```ts
// resolve.ts
export type ResolutionChoice = 'mine' | 'cloud' | 'both' | 'keep' | 'delete';
export function applyResolution(merged: GraphSnapshot, conflict: GraphConflict, choice: ResolutionChoice, newId: () => string): GraphSnapshot;
// db.ts
export type SaveResult = { saved: true; version: number } | { saved: false; version: number };
export function bulkSaveCanvasToDb(nodes: CanvasNode[], connections: Connection[], projectId?: string, baseVersion?: number): SaveResult | Promise<SaveResult>;
export function getGraphVersion(projectId: string): number | Promise<number>;
```
- **Choices:**
  - `mine` keeps the local item.
  - `cloud` takes the remote item, or deletes it when remote deleted it.
  - `both` is only for `both-changed` nodes: keep the local node and add the remote node under `newId()`, titled `${remote.title} (conflict copy)` with no edges.
  - `keep` and `delete` are for `deleted-*` conflicts. `keep` restores whichever side still has the item.
  - For `title` conflicts, only `mine` and `cloud` are valid.
- **HTTP:**
  - `GET /api/graph` adds `version`.
  - `PUT /api/graph` accepts an optional numeric `baseVersion`. A mismatch returns `409 { error: 'This map changed elsewhere.', version }`. On success it returns `{ saved, version, ... }`.

- [ ] **Step 1: Write failing tests:**
  - `resolve mine/cloud/both`: for `both` with `newId = () => 'copy1'`, the result contains `a` (local) and `copy1` (`title` ends with `' (conflict copy)'`, no edges touch it).
  - `resolve keep restores a deleted node`.
- [ ] **Step 2: Run** `npm test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `applyResolution`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Add the `graphVersion` column** in all three schema places (SQLite `INTEGER NOT NULL DEFAULT 0` via the `projectColumns` ALTER loop; Postgres `graph_version INTEGER NOT NULL DEFAULT 0`).
- [ ] **Step 6: Version the saves.** Every call to `bulkSaveCanvasToDb` increments the version, including the research review commit and revision restore, which already go through it.
  - **SQLite:** inside the existing transaction, read the version. If `baseVersion !== undefined && baseVersion !== current`, return `{ saved: false, version: current }` without writing.
  - **Neon:** first run `UPDATE projects SET graph_version = graph_version + 1 WHERE id = $1 AND ($2::int IS NULL OR graph_version = $2) RETURNING graph_version`. No row means `{ saved: false }`; then write the graph.
  - Add a `ponytail:` comment on the Neon path: the bump and the write aren't atomic. A failed write leaves a bumped version, which only causes a harmless extra merge.
- [ ] **Step 7: Update `/api/graph`** for the HTTP contract above. Reject a `baseVersion` that's present but isn't a non-negative integer with 400.
- [ ] **Step 8: Verify the stale-save case** (`stale baseVersion is rejected`): with `npm run dev`, GET a map (`version: n`), PUT with `baseVersion: n` → 200 with `version: n+1`; PUT again with `baseVersion: n` → 409. Run `npx tsc --noEmit` and `npm test`, both clean.
- [ ] **Step 9: Commit** `feat: graph versions with 409 on stale saves, conflict resolution`

### Task 4: Web autosave merges on 409, and the conflict panel

**Files:**
- Create: `src/components/sync/ConflictPanel.tsx`
- Modify: `src/app/app/page.tsx` (graph load ~line 402 and 997, autosave effect ~lines 614–650)

**Interfaces:**
- Consumes: `mergeGraphs` and `sameGraph` (Task 2), `applyResolution` (Task 3), and the `/api/graph` version contract (Task 3).
- Produces:
```tsx
export function ConflictPanel(props: {
  conflicts: GraphConflict[];
  onResolve: (conflictId: string, choice: ResolutionChoice) => void;
  onClose: () => void;
}): JSX.Element
```
- **Panel:** shows each conflict as **Your version** and **Cloud version** side by side: title, content (via the existing `MarkdownView`), status, and links in and out.
  - Buttons per conflict reason: `both-changed` gets Keep mine / Keep cloud / Keep both; `deleted-*` gets Keep it / Delete it; `title` gets Keep mine / Keep cloud.
  - There is no resolve-all button.
  - The banner reads `${n} conflict${n === 1 ? '' : 's'} need your decision`.
  - Match the styling of the research review UI.

- [ ] **Step 1: Track versions.** In `page.tsx`, keep `graphVersionRef` and `lastSyncedGraphRef` (the snapshot last loaded or saved). Set both from GET and successful PUT responses, and send `baseVersion: graphVersionRef.current` on every autosave PUT.
- [ ] **Step 2: Merge on 409.** GET the cloud graph and run `mergeGraphs(lastSynced, current, cloud)`.
  - **No conflicts:** apply the merged graph as a remote update (`remoteGraphRef`, so no history snapshot), set the refs to cloud and the version, and let autosave save again.
  - **Conflicts:** apply the merged graph, pause autosave, and show `ConflictPanel`. Each resolution goes through `applyResolution` and `updateGraph`. Once the last conflict is resolved, resume autosave.
- [ ] **Step 3: Verify manually:** run `npm run dev` and open the same map in two tabs.
  - Edit note A in tab 1 and note B in tab 2 → both survive after a reload.
  - Edit note A's text in both tabs → the second tab shows the panel. **Keep both** leaves A plus `A (conflict copy)`.
  - Run `npx tsc --noEmit`, `npm run lint` and `npm test`, all clean.
- [ ] **Step 4: Commit** `feat: web autosave merges concurrent edits and asks on conflicts`

### Task 5: Device tokens and the connect flow (cloud)

**Files:**
- Modify: `src/lib/db.ts`, `src/lib/neon.ts`, `scripts/schema-postgres.sql` (table `device_tokens`)
- Modify: `src/lib/auth.ts`
- Modify: `src/middleware.ts`
- Create: `src/app/desktop/connect/page.tsx`
- Create: `src/app/api/device/tokens/route.ts`

**Interfaces:**
- Produces:
```ts
// db.ts (+ neon counterparts)
export function createDeviceToken(userId: string, label: string): { id: string; token: string } | Promise<...>;   // token = 'sxd_' + base64url(32 random bytes); store sha256 hex only
export function getUserIdForDeviceToken(token: string): string | null | Promise<string | null>;            // null if unknown or revoked; updates lastUsedAt
export function listDeviceTokens(userId: string): Array<{ id: string; label: string; createdAt: number; lastUsedAt: number | null }> | Promise<...>;
export function revokeDeviceToken(id: string, userId: string): boolean | Promise<boolean>;
// auth.ts
export interface AuthContext { /* existing */ isDevice?: boolean }
```
- **Table:** `device_tokens(id, user_id, token_hash UNIQUE, label, created_at, last_used_at, revoked_at)`.
- **Routes:**
  - `POST /api/device/tokens {label}` → `{ token }`. Clerk session only, never a device token.
  - `GET /api/device/tokens` → the user's devices.
  - `DELETE /api/device/tokens?id=` revokes one.

- [ ] **Step 1: Add the table and functions** in all three places. Use `crypto.randomBytes`, `createHash('sha256')`, and compare by hash lookup.
- [ ] **Step 2: Accept device tokens in `getServerAuth()`.** When Clerk is configured, read `authorization` with `headers()` from `next/headers`. If it's `Bearer sxd_…`, resolve the user and return `{ userId, clerkId: user.clerkId, orgId: null, orgRole: null, isLocal: false, isDevice: true, user }`. An unknown token returns the signed-out context. Never fall through to Clerk when a Bearer header is present.
- [ ] **Step 3: Update the middleware.** Skip `auth.protect()` for requests with a `Bearer sxd_` header to `/api/graph`, `/api/upload` and `/api/device/(.*)`, except `/api/device/tokens`. Those routes authenticate through `getServerAuth()`.
- [ ] **Step 4: Build `/desktop/connect`.**
  - The page requires a Clerk session (redirect to sign-in).
  - It shows a **Connect this desktop** button, which POSTs `/api/device/tokens` with label `Desktop (${date})` and then sets `location.href = 'synthex://connect?token=' + token`.
  - It also lists the user's devices with **Revoke** buttons.
- [ ] **Step 5: Verify:** with Clerk keys in `npm run dev`, connect yields a token. `curl -H "Authorization: Bearer <token>" "localhost:3000/api/graph?projectId=<personal map>"` returns 200. After a revoke, the same curl returns 401. A team map ID returns 404. Run `npx tsc --noEmit` clean.
- [ ] **Step 6: Commit** `feat: revocable device tokens for desktop sync`

### Task 6: Device API (cloud)

**Files:**
- Create: `src/app/api/device/projects/route.ts`
- Create: `src/app/api/device/projects/[id]/route.ts`
- Modify: `src/app/api/graph/route.ts`
- Uses existing `createProjectInDb(id, title, userId, null)`, `projectExistsInDb`, `renameProjectInDb` and `deleteProjectFromDb`. No db changes.

**Interfaces:**
- Consumes: `AuthContext.isDevice` (Task 5), `graphVersion` (Task 3).
- Produces (all require `isDevice`, otherwise 404):
  - `GET /api/device/projects` → `{ userId: string; fileSync: boolean; projects: Array<{ id: string; title: string; version: number }> }`. Lists personal maps only (`getProjectsFromDb(userId, null, ...)`). `fileSync = Boolean(process.env.GCS_BUCKET_NAME)`.
  - `PUT /api/device/projects/[id] { title }` creates the project with that ID, owned by the user and personal, when it doesn't exist, or renames it if the user has access. If the ID belongs to someone else, return 403.
  - `DELETE /api/device/projects/[id]?baseVersion=n` → 409 `{ version }` if the version moved on, otherwise deletes and returns 200.
  - **Status codes for device callers in `/api/graph` and above:** 403 when the project exists but this user can't access it, 410 when it doesn't exist. Non-device callers keep 404.

- [ ] **Step 1: Implement the routes.** Validate `id` (≤ 80 chars, `project-` prefix) and `title` (1–255 chars).
- [ ] **Step 2: Branch the device status codes.** In `/api/graph` GET and PUT, when `auth.isDevice`, choose 403 or 410 using `projectExistsInDb(id)`. 410 is "no such project". The plan doesn't distinguish "deleted" from "never existed", because the desktop only asks about IDs it has synced.
- [ ] **Step 3: Verify with curl** using a device token: list → create `project-test-1` → PUT graph `baseVersion: 0` → DELETE `?baseVersion=0` → 409 → DELETE `?baseVersion=1` → 200 → GET graph → 410. Run `npx tsc --noEmit` clean.
- [ ] **Step 4: Commit** `feat: device API for desktop sync`

### Task 7: Desktop sync store (SQLite)

**Files:**
- Create: `src/lib/sync/store.ts`

**Interfaces:**
- Consumes: `getDatabase` from `../db.ts`, and `GraphSnapshot` / `GraphConflict` from Task 2.
- Produces:
```ts
export type SyncStatus = 'synced' | 'pending' | 'conflicts' | 'error' | 'no-access';
export interface SyncRow {
  projectId: string; accountId: string | null; offline: boolean;
  baseGraph: GraphSnapshot | null; baseVersion: number | null;   // null = never pushed
  status: SyncStatus; conflicts: GraphConflict[]; error: string | null;
  readOnly: boolean; deletedLocally: boolean; lastSyncedAt: number | null;
}
export interface SyncAccount { token: string; userId: string; cloudUrl: string; connectedAt: number }
export const syncStore: {
  getAccount(): SyncAccount | null; setAccount(a: SyncAccount | null): void;
  getRow(projectId: string): SyncRow | null; listRows(): SyncRow[];
  saveRow(row: SyncRow): void; deleteRow(projectId: string): void;
  readLocalGraph(projectId: string): GraphSnapshot | null;            // project title + nodes + edges via existing db fns
  writeLocalGraph(projectId: string, g: GraphSnapshot): void;          // bulkSaveCanvasToDb + renameProjectInDb/createProjectInDb; creates a local revision first
  addLocalFile(url: string, projectId: string): void; listLocalFiles(projectId: string): string[]; removeLocalFile(url: string): void;
};
```
- **Tables:** `sync_state`, `sync_account` (single row, `id = 1`) and `local_files(url PK, projectId)`, created lazily in this module on first use. SQLite only; return 404 from callers when `SYNTHEX_DESKTOP !== '1'`.
- `writeLocalGraph` calls `createGraphRevision(projectId, 'Before sync', ...)` before writing, so a sync can be undone.

- [ ] **Step 1: Implement `store.ts`.** Have the upload route (Task 1 branch) call `syncStore.addLocalFile` when `SYNTHEX_DESKTOP === '1'`.
- [ ] **Step 2: Verify:** run `npx tsc --noEmit` clean. The store is covered through the engine in Task 8, with a fake.
- [ ] **Step 3: Commit** `feat: desktop sync state store`

### Task 8: Sync engine

**Files:**
- Create: `src/lib/sync/engine.ts`
- Test: `tests/sync.test.mjs`

**Interfaces:**
- Consumes: `mergeGraphs` and `sameGraph` (Task 2), the `syncStore` shape (Task 7, passed in rather than imported, so tests can fake it), and the cloud contract (Tasks 3 and 6).
- Produces:
```ts
export interface CloudClient {
  listProjects(): Promise<{ userId: string; fileSync: boolean; projects: { id: string; title: string; version: number }[] }>;
  getGraph(id: string): Promise<{ status: 200; graph: GraphSnapshot; version: number } | { status: 403 | 410 }>;
  putGraph(id: string, g: GraphSnapshot, baseVersion: number): Promise<{ status: 200; version: number } | { status: 409; version: number } | { status: 413 | 400; error: string }>;
  upsertProject(id: string, title: string): Promise<void>;
  deleteProject(id: string, baseVersion: number): Promise<{ status: 200 } | { status: 409; version: number }>;
  uploadFile(projectId: string, localUrl: string): Promise<string>;   // returns cloud URL
}
export function syncProject(store: typeof syncStore, cloud: CloudClient, projectId: string): Promise<SyncRow>;
export function syncAll(store: typeof syncStore, cloud: CloudClient): Promise<SyncRow[]>;
```
- **Algorithm** (spec §6), per project, under an in-process per-project lock (a `Map<string, Promise<SyncRow>>`, where a second caller awaits the first):
  1. Skip rows whose `accountId` differs from the connected account.
  2. If `deletedLocally`, call `deleteProject` with `baseVersion`. On 200, delete the local row and project. On 409, set conflicts to `[{ id: 'project:' + id, kind: 'project', itemId: id, reason: 'deleted-local' }]` and status `conflicts`.
  3. If `baseVersion === null`, call `upsertProject`, then `putGraph(local, 0)`.
  4. Otherwise `getGraph`:
     - 403 → `readOnly`, status `no-access`.
     - 410 → a `deleted-remote` project conflict. Resolving it with `keep` sets `baseVersion = null`.
     - If remote is unchanged (`version === baseVersion`) and local equals the base, set status `synced`.
     - If only remote changed, write remote locally.
     - Otherwise merge. With conflicts, write the merged graph locally, store the conflicts and set status `conflicts` without pushing. With none, write locally, upload local files first (if `fileSync` is on; otherwise leave them and add `'Files stay on this device: cloud file storage is off.'` to `error`), rewrite node URL fields (`imageUrl`, `url`, `fileData`) from local to cloud URLs, then `putGraph`.
  5. On a 409, retry from step 4 up to 3 times, then set status `error`. On 413 or 400, set status `error` with the server message; base and local stay unchanged. If anything throws (network), set status `error` with `'Could not reach the cloud.'`, leaving base unchanged.
  6. On a successful push, set `baseGraph` to the pushed graph and `baseVersion` to the new version, with status `synced`.
  - Rows with conflicts don't push until `conflicts` is empty. Resolution happens in Task 9.

- [ ] **Step 1: Write failing tests** with an in-memory fake store and fake cloud:
  - `first push creates the cloud project`.
  - `pulls remote-only changes`.
  - `merges and pushes non-overlapping changes`: `putGraph` is called with `baseVersion` equal to the cloud version.
  - `stores conflicts and does not push`.
  - `push failure keeps base and local`: `putGraph` throws, so status is `error` and the base is unchanged.
  - `413 marks error and keeps data`.
  - `retries on 409 then succeeds`.
  - `lost access makes the map read-only`.
  - `concurrent syncs push once`: `Promise.all([syncProject(...), syncProject(...)])` calls `putGraph` exactly once.
  - `skips rows from another account`.
- [ ] **Step 2: Run** `npm test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `engine.ts`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: desktop sync engine`

### Task 9: Desktop sync API (local server)

**Files:**
- Create: `src/lib/sync/cloud-client.ts`
- Create: `src/app/api/sync/route.ts`
- Modify: `src/lib/ai-service.ts` (`getAIStatus`)

**Interfaces:**
- Consumes: `syncStore` (Task 7), `syncProject` / `syncAll` / `CloudClient` (Task 8), `applyResolution` (Task 3).
- Produces: `createCloudClient(account: SyncAccount): CloudClient`, which uses `fetch` with `Authorization: Bearer`. Then `/api/sync`, which returns 404 unless `SYNTHEX_DESKTOP === '1'`:
  - `GET` → `{ account: { userId, cloudUrl } | null, online: boolean, rows: SyncRow[] (without baseGraph), cloudProjects: {id,title,version}[] }`. `online` is the result of a 3-second `listProjects()` attempt.
  - `POST { action }`:
    - `'connect', token`: verify with `listProjects()`, then `setAccount`. If a *different* `userId` was connected before, keep those rows and never sync them, as the account check already ensures. Returns the local maps that have no row, for the "upload these?" prompt.
    - `'upload-local', projectIds[]`: rows with `offline: true`, `baseVersion: null`, and `accountId` set.
    - `'disconnect'`: `setAccount(null)`. Rows stay.
    - `'set-offline', projectId, offline`: for a cloud project with no row, creates a row and pulls it.
    - `'sync', projectId?`.
    - `'resolve', projectId, conflictId, choice`: applies the choice to the local graph and removes the conflict. When none are left, it runs `syncProject`. A `project` conflict accepts only `keep` or `delete`:
      - `deleted-remote` + `keep`: set `baseVersion = null` so the map is re-created in the cloud.
      - `deleted-remote` + `delete`: remove the map locally.
      - `deleted-local` + `keep`: clear `deletedLocally` so the map stays.
      - `deleted-local` + `delete`: delete it in the cloud anyway, with the current version.
    - `'delete-local', projectId`: sets `deletedLocally` when the map was pushed before, otherwise deletes it locally.
    - `'remove-from-device', projectId`: deletes the local project and its row.
  - `getAIStatus()` returns `configured: false` and adds `desktop: true` when `SYNTHEX_DESKTOP === '1'`. Add `desktop?: boolean` to `AIStatus`.
  - The token is never logged and never returned in responses.

- [ ] **Step 1: Implement the cloud client.** `uploadFile` reads the file from `SYNTHEX_UPLOAD_DIR` and POSTs multipart to `${cloudUrl}/api/upload` with the projectId.
- [ ] **Step 2: Implement the route.** Validate `action`, the IDs (≤ 80 chars) and `choice` against `ResolutionChoice`.
- [ ] **Step 3: Verify** against a cloud running on another port (`PORT=3001`, Clerk configured) and a desktop-mode dev server (`SYNTHEX_DESKTOP=1 SYNTHEX_CLOUD_URL=http://localhost:3001`): connect with a token, upload a local map and see it in the cloud web app, edit in both, `POST sync` → the edits merged. Run `npx tsc --noEmit` and `npm test` clean.
- [ ] **Step 4: Commit** `feat: desktop sync API`

### Task 10: Desktop workspace UI

**Files:**
- Create: `src/components/sync/SyncStatusChip.tsx`
- Create: `src/components/sync/useDesktopSync.ts`
- Modify: `src/app/app/page.tsx`
- Modify: `src/components/research/MapsManager.tsx`
- Reuse: `ConflictPanel` (Task 4)

**Interfaces:**
- Consumes: `/api/sync` (Task 9) and `AIStatus.desktop` (Task 9).
- Produces: `useDesktopSync(projectId: string | null)` → `{ enabled: boolean; online: boolean; row: SyncRow | null; rows: SyncRow[]; cloudProjects: ...; syncNow(): Promise<void>; act(body: object): Promise<unknown> }`. `enabled` is false when `GET /api/sync` returns 404, which is how it behaves on web, where the hook is a no-op.

- [ ] **Step 1: Sync timing.** The hook polls `GET /api/sync` every 60 s and on `window` `online`, and calls `syncNow()` 5 s after the last autosave (debounced).
- [ ] **Step 2: Status chip.** It shows Offline · Synced · Syncing · Conflicts · Sync error, plus a **Sync now** button. On error, it shows `row.error`.
- [ ] **Step 3: Read-only maps.**
  - When `row.readOnly`, or when the map isn't offline (`!row.offline`) and the app is offline, `updateGraph` no-ops and announces `This map is read-only right now.`
  - For `readOnly`, a banner reads `You no longer have access to this map.` with **Export** (the existing vault export) and **Remove from this device** buttons.
- [ ] **Step 4: Conflicts.** When `row.status === 'conflicts'`, show the `ConflictPanel` banner. `onResolve` calls `act({ action: 'resolve', ... })` and then reloads the graph.
- [ ] **Step 5: Map list** (`MapsManager`, when `enabled`):
  - Each map gets an **Available offline** toggle (`set-offline`).
  - Cloud maps with no local row are labeled "Online only".
  - **Delete** routes through `delete-local`.
  - **Remove from this device** first shows a warning naming any unsynced changes (`status === 'pending' | 'conflicts' | 'error'`).
- [ ] **Step 6: Connect account.**
  - **Connect account** opens `${cloudUrl}/desktop/connect` with `window.open`, which Electron routes to the system browser in Task 11.
  - After `connect`, show the "Upload these maps to your account?" list, all ticked, and send `upload-local` with the ticked ones.
  - Also offer **Disconnect**.
- [ ] **Step 7: AI off.** When `aiStatus.desktop` is set, hide the AI composer, research, chat, `/organize` and `/check` entry points, and show `AI is available in the web app.` where the composer would be.
- [ ] **Step 8: Verify** with the two-server setup from Task 9, in the in-app browser:
  - Toggle a map offline, edit it, then stop the cloud server → the chip shows Offline and edits are still saved.
  - Edit the same note on the cloud, restart the cloud → the conflict panel appears, and Keep mine syncs.
  - Run `npx tsc --noEmit`, `npm run lint` and `npm test`, all clean.
- [ ] **Step 9: Commit** `feat: desktop sync UI, read-only and AI-off states`

### Task 11: Electron shell and Windows installer

**Files:**
- Create: `electron/main.cjs`
- Create: `scripts/desktop-prepare.mjs`
- Modify: `package.json` (devDependencies `electron`, `electron-builder`, `@electron/rebuild`; scripts; a `build` config block)
- Modify: `.gitignore` (`dist-desktop/`)

**Interfaces:**
- Consumes: the env contract (Global Constraints) and `POST /api/sync { action: 'connect', token }` (Task 9).

- [ ] **Step 1: Write `scripts/desktop-prepare.mjs`.** After `next build`, copy `public/` → `.next/standalone/public` and `.next/static` → `.next/standalone/.next/static`. Then run `@electron/rebuild` on `.next/standalone` for `better-sqlite3`, targeting the installed Electron version.
- [ ] **Step 2: Write `electron/main.cjs`:**
  - Use a single-instance lock and register `synthex` with `app.setAsDefaultProtocolClient`.
  - Pick a free port (`net.createServer().listen(0)`) and spawn `process.execPath` on `standalone/server.js` with `ELECTRON_RUN_AS_NODE=1`, `PORT`, `HOSTNAME=127.0.0.1`, `SYNTHEX_DESKTOP=1`, `SYNTHEX_DATA_DIR=app.getPath('userData')`, `SYNTHEX_UPLOAD_DIR=<userData>/uploads` and `SYNTHEX_CLOUD_URL` (the production URL, overridable by env). Strip any Clerk, Neon and AI env vars from the child.
  - Poll `/api/ai/status` until it returns 200, with a 30 s timeout that shows an error dialog. Then load `/app`.
  - `setWindowOpenHandler` opens external URLs with `shell.openExternal` and denies them in-app.
  - On `second-instance` and `open-url`, parse `synthex://connect?token=`, then POST it to the local `/api/sync` and focus the window.
  - Kill the child process on quit.
- [ ] **Step 3: Configure `package.json`:**
  - Scripts: `"desktop": "next build && node scripts/desktop-prepare.mjs && electron electron/main.cjs"` and `"desktop:build": "next build && node scripts/desktop-prepare.mjs && electron-builder --win nsis"`.
  - `build`: `appId: com.synthex.studio`, `productName: Synthex Studio`, `files: ["electron/**"]`, `extraResources: [{ from: ".next/standalone", to: "standalone" }]`, `directories.output: dist-desktop`, `protocols: [{ name: "Synthex", schemes: ["synthex"] }]`, `win.icon` set to `src/app/icon.png`.
  - `main.cjs` resolves `standalone` from `process.resourcesPath` when packaged, and from `.next/standalone` in dev.
- [ ] **Step 4: Verify:**
  - `npm run desktop` opens the window at `/app`. A new map persists across restarts in `%APPDATA%/Synthex Studio/canvas.db`.
  - `npm run desktop:build` produces `dist-desktop/*.exe`. Installing and launching it works, and the AI entry points show the web-app note.
  - `npm run build` still succeeds with no `SYNTHEX_*` vars, which confirms Vercel is unaffected.
- [ ] **Step 5: Commit** `feat: Electron desktop shell and Windows installer`

### Task 12: Make offline copy of a team map (web)

**Files:**
- Create: `src/app/api/projects/copy/route.ts`
- Create: `src/lib/sync/copy.ts`
- Modify: `src/components/research/MapsManager.tsx`
- Test: `tests/sync.test.mjs`

**Interfaces:**
- Produces: `copyGraphWithNewIds(g: GraphSnapshot, newId: () => string): GraphSnapshot`. It remaps every node ID, edge ID, edge `from`/`to`, node `sectionId` and `metadata.sourceIds` / `evidence[].sourceId`. Then `POST /api/projects/copy { projectId }`: does the usual access check, creates a personal project `project-${randomUUID()}` titled `${title} (offline copy)`, saves the remapped graph, and returns `{ project }`.

- [ ] **Step 1: Write a failing test** (`copy remaps every reference`): after the copy, no old ID appears anywhere in the JSON, and `normalizeGraph` accepts the result.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `copy.ts` and the route.
- [ ] **Step 4: Add the action.** In `MapsManager` on web, team maps get a **Make offline copy** action that calls the route and then opens the copy. It shows up on desktop as an online-only personal map, and the user turns on **Available offline** there. (Deviation from the spec, flagged for the user: the copy action is web-only and the copy isn't marked offline automatically. That's because desktop tokens only see personal maps.)
- [ ] **Step 5: Run** `npm test` and `npx tsc --noEmit`. Expected: both clean.
- [ ] **Step 6: Commit** `feat: make an offline copy of a team map`
