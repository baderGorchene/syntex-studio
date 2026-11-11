# Desktop app with offline work and Git-style sync

Date: 2026-10-28
Status: draft for review

## Intent

Synthex Studio should also ship as an installable desktop app (Windows first). The desktop app must keep working with no connection, save everything locally, and sync with the cloud when it's back online. When the same thing was changed in two places, the sync works the way Git does: changes that don't overlap merge on their own, and real collisions become conflicts that a person resolves. Nothing gets resolved silently.

**Anti-goal:** someone's offline work disappears without anyone being asked. If a design choice could cause that, it's wrong, even when it's simpler.

## Goals

1. Desktop installer (Electron) that runs the existing Next app locally. Same codebase, same `src/`. Vercel and Cloud Run keep working unchanged.
2. Full map editing offline, saved to local SQLite.
3. Back online: a three-way merge of each map (last synced version, local version, cloud version).
4. Non-overlapping changes merge automatically. Overlapping changes become conflicts resolved in a review screen.
5. The web app can no longer blindly overwrite changes the desktop pushed (see "Web autosave", below).

## Non-goals (v1)

- macOS and Linux builds. The design shouldn't block them, but only Windows ships.
- Syncing research history, chat threads, graph revisions or credits. These stay per device in v1. Only projects, nodes and links sync.
- Live collaboration inside the desktop app, and team maps on desktop at all, except as personal offline copies.
- AI features in the desktop app.
- Auto-updates and code signing. Planned, but not part of this work.
- Merging inside a note's text (line-level merge of `content`). A note is the smallest unit of conflict.

## Constraints from the existing code

- All map writes go through `PUT /api/graph` → `bulkSaveCanvasToDb`, which deletes and rewrites a project's whole graph. Today there's no version check, so whoever saves last wins. Two browser tabs without collab can already overwrite each other.
- `normalizeGraph` rejects dangling links, so a merged graph has to drop links whose endpoints were deleted, the same way the research commit flow does.
- Project IDs are `project-${randomUUID()}` and node IDs are client-generated, so IDs created offline won't collide with cloud IDs. Keep it that way.
- Schema changes go in three places: SQLite in `db.ts`, Neon auto-init in `neon.ts`, and `scripts/schema-postgres.sql`.
- Modules imported by `tests/graph.test.mjs` need `.ts` extensions in relative imports and no enums.
- Cloud API keys and the Neon connection string must never ship inside the installer.

## How it works

### 1. Desktop shell

- `electron/main.js` starts `.next/standalone/server.js` with Electron's Node (`ELECTRON_RUN_AS_NODE`) on a free `127.0.0.1` port, waits for it to respond, then opens a window at `/app`.
- The local server runs with no Clerk or Neon variables, so it uses local mode and SQLite, which already works today.
- Two new optional environment variables, `SYNTHEX_DATA_DIR` and `SYNTHEX_UPLOAD_DIR`, move `canvas.db` and uploads into Electron's `userData` folder. When they're unset, behavior is exactly as it is now.
- `electron-builder` produces an NSIS `.exe` installer and rebuilds `better-sqlite3` for Electron's Node version. `electron` and `electron-builder` are dev dependencies. Set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` on Vercel.

### 2. Linking the desktop to a cloud account

My call: device tokens, not cookies.

- In the desktop app, **Connect account** opens the system browser at `{CLOUD_URL}/desktop/connect`. Opening a real browser matters because Google blocks sign-in inside embedded windows.
- After Clerk sign-in, that page creates a **device token**: random, stored hashed in a new `device_tokens` table, tied to the user, revocable, and listed on an account page. The browser hands the token back to the app through a `synthex://connect?token=…` deep link.
- The local server stores the token in its SQLite database. It never goes into a URL after that handoff, and never into a log.
- `getServerAuth()` on the cloud also accepts `Authorization: Bearer <device token>` and resolves it to the same user, so the existing `userHasProjectAccess` checks apply unchanged.
- All sync calls go **server to server**, from the local Next server to the cloud API. The renderer never calls the cloud directly, so there are no CORS or cookie problems.

### 3. Versioning on the server

- Add a `graphVersion` integer column to projects (default 0).
- `GET /api/graph` also returns `version`.
- `PUT /api/graph` accepts an optional `baseVersion`. When it's present and doesn't match, the route returns **409** with the current version and writes nothing. When the versions match, it saves and increments the version in the same transaction (Postgres: a conditional `UPDATE … WHERE graphVersion = $base`). Without `baseVersion`, the route behaves as it does today, so old clients keep working during rollout.

### 4. Local sync state (desktop)

There's a new local table, `sync_state`, with one row per project:

- `baseGraph`: JSON of the graph exactly as it was at the last successful sync
- `baseVersion`: the cloud version that graph matches
- `status`: `synced` | `pending` | `conflicts` | `error`
- `conflicts`: JSON list, while there are unresolved conflicts

Projects created offline have no row until their first push. A project deleted in the cloud while the user edited it offline becomes a project-level conflict: keep it, which re-creates it in the cloud, or discard the local copy.

Which maps are on the desktop is set out in section 4b.

### 4b. Which maps go offline (decided)

- **The user chooses, per map,** whether a map is available offline. Only maps marked offline are stored and synced on the desktop. The desktop lists the user's other personal maps as "Online only". Opening one downloads it and syncs it with the same engine. It's editable only while connected and goes read-only when the connection drops. *(How online-only maps work on desktop is my call.)*
- **Team maps can't be offline.** The desktop doesn't sync them. Instead, a team map has a **Make offline copy** action, available in the web app and in the desktop's map list. It creates a new **personal** map, with a new project ID and fresh node and link IDs, that starts out marked offline. The copy is independent: it never merges back into the team map. *(Never merging back is my reading of "make a copy".)* Team maps on desktop show only "Open in browser".
- This means device tokens only ever reach **personal maps** (`orgId = null`), which matches how local mode already scopes projects. The org question goes away.
- **Maps created on the desktop** are personal and offline. On first connect, the app lists any maps made before connecting and asks which ones to upload, all ticked by default. Unticked maps stay local-only. *(My call.)*
- **Disconnecting or switching accounts:** maps from the old account stay on the device, labeled with that account, and never sync to a different account. **Remove from this device** is offered with a warning that lists any unsynced changes. *(My call.)*

### 5. The merge (pure function, shared)

`mergeGraphs(base, local, remote)` goes in `src/lib/graph-merge.ts`. It's pure, with `.ts` imports, and covered in `tests/`. It returns `{ merged, conflicts }`.

It runs per node ID and per link ID:

| base | local | remote | result |
|---|---|---|---|
| — | added | — | keep local |
| — | — | added | keep remote |
| — | added | added (same ID) | equal → keep; different → conflict |
| x | unchanged | changed | take remote |
| x | changed | unchanged | take local |
| x | changed | changed | equal → keep; otherwise conflict |
| x | deleted | unchanged | delete |
| x | unchanged | deleted | delete |
| x | deleted | changed | **conflict** |
| x | changed | deleted | **conflict** |

- **Layout fields** (`x`, `y`, `width`, `height`, and view state such as a section's `metadata.collapsed`) never cause a conflict. When both sides changed one, local wins. Comparison ignores these fields, and they merge separately. My call: folding is view state, so it must not set off conflicts on every member note.
- **`sectionId` (which cluster a note belongs to) is content**, but it's compared as its own field. Moving a note into a cluster on one side and editing its text on the other merges cleanly. Only a different `sectionId` on both sides is a conflict. My call.
- **Content fields** are everything else on the node, compared as a whole.
- After merging, links whose endpoints no longer exist are dropped, and that's reported in the sync summary rather than silently. If the reason is that one side deleted a note that the other side linked to, it's a conflict on the note instead.
- The merged result goes through `normalizeGraph`.

### 6. The sync loop (desktop, local server)

The loop is triggered when the connection comes back, every 60 seconds while online, after local autosaves (debounced), and by a **Sync now** button.

For each project:

1. `GET` the cloud graph and version.
2. If the cloud version equals `baseVersion` and there are no local changes, do nothing. If only the cloud changed, take it.
3. Otherwise, `mergeGraphs(baseGraph, localGraph, cloudGraph)`.
4. **No conflicts:** save the merged graph locally, then `PUT` it to the cloud with `baseVersion = cloudVersion`. On success, the new `baseGraph` is the merged graph and `baseVersion` is the new version. On a 409, start over from step 1, up to 3 times, then mark the project `error`.
5. **Conflicts:** save the auto-merged parts locally, store the conflicts, and mark the project `conflicts`. Pushing pauses for this project until the conflicts are resolved. The user can keep editing meanwhile.

Before applying a merge that changes the local graph, write a local graph revision (the existing revisions feature), so every sync can be undone.

### 7. Resolving conflicts (UI)

This builds on the pattern of the research review flow (pending changes, accepted or rejected one by one).

- A banner on the map reads "3 conflicts need your decision" and opens the review panel.
- Each conflict shows **Your version** and **Cloud version** side by side (title, content, status, and links in and out). The choices are:
  - **Keep mine**
  - **Keep cloud**
  - **Keep both**, which duplicates the note with a new ID and the title suffixed "(conflict copy)". Only for edit/edit conflicts.
  - For delete/edit conflicts: **Keep it** or **Delete it**.
- The map syncs once every conflict is decided.
- There's no "resolve all" button in v1, so nothing gets resolved without a decision. My call; it's easy to add later.

### 8. Web autosave

The web client sends `baseVersion` on every `PUT /api/graph`. On a 409, it fetches the cloud graph and runs the same `mergeGraphs`, using its last-loaded graph as the base:

- No conflicts: apply the merge and save again.
- Conflicts: show the same review panel.

In a live collab room, teammates' edits already arrive through Yjs, so 409s there should be rare and should merge cleanly. If they turn out noisy in practice, collab rooms can skip the check, but the default is to check everywhere. Without this step, a stale browser tab would wipe out everything the desktop just pushed.

### 8b. Map-level changes (my calls)

- **Title:** merged three-way like a node field. A title changed on one side is taken. Both changed and different is a conflict in the same panel.
- **Workspace move** follows the cloud. Only the cloud can move maps between workspaces.
- **Deleting a synced map on the desktop:** a local tombstone is pushed. If the user created the map and the cloud has no newer changes since `baseVersion`, the cloud map is deleted. If the cloud has newer changes, it's a project-level conflict (delete anyway, or keep). If the user isn't the creator, the delete only removes the local copy and stops syncing it, and the app says so.
- **Lost access vs deleted:** the sync endpoint must tell the two apart (`410 Gone` for deleted, `403` for no access, which only device-token callers receive, so normal web routes keep their 404). On lost access, the local copy becomes read-only and is marked "You no longer have access". The user can export it or remove it. It's never re-created in the cloud.
- **Other whole-graph writers** (research review commit, revision restore) bump `graphVersion` as well.

### 9. Files and images offline

Desktop sync **requires GCS on the cloud** (`GCS_BUCKET_NAME`). Without it, the sync UI says file sync is unavailable and pushes notes without their local-only files, keeping them local and listed in the sync summary. My call: relative `/uploads` URLs and data URIs can't be told apart from local files, and data URIs would push the graph past the 5 MB limit. Local-only files are tracked in a `local_files` table (file ID → node), not detected from the URL.


Uploads made offline are stored in the local upload folder, and the node URL points to the local server. On push, the sync uploads each local-only file to the cloud's `POST /api/upload`, rewrites the node URLs to the returned cloud URLs, and then pushes the graph. On pull, cloud files are downloaded on first view and cached so they're available offline.

### 10. Offline indicators

- A status chip shows Offline · Synced · Syncing · Conflicts · Sync error.
### 11. AI on desktop (decided)

AI is turned off automatically in the desktop app. The AI chat, research, `/organize`, `/check`, analysis and embeddings are hidden in the desktop build, with a short "AI is available in the web app" note where they would be. The desktop app ships no AI keys, no key-entry screen and no credit proxy. Notes synced up from the desktop get indexed for search on the cloud by the normal `PUT /api/graph` → `indexGraphNodes` path. *(Reading "turned off" as off for the whole desktop app, not only while offline, is my interpretation.)*

## Left to the builder

- Electron window chrome, menus, single-instance lock and the deep-link registration details.
- How online/offline is detected (`net.isOnline()` plus a cloud health ping is fine).
- Exact table and column names, and the JSON shapes in `sync_state`.
- The visual design of the conflict panel, within the existing review UI's style.
- Retry and backoff timing.

## Open questions

None. The user's decisions are in sections 4b and 11.
