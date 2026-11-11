# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Next.js 16 warning

This is Next.js 16.3 / React 19.2 and has breaking changes. APIs, conventions, and file structure may all differ from your training data. Before writing framework code, read the relevant guide in `node_modules/next/dist/docs/` and pay attention to deprecation notices. `next dev` keeps a managed rules block in `AGENTS.md`. Leave it in place.

`AGENTS.md`, `README.md`, `GRAPH.md` and `TODO.md` contain long design and audit notes. Parts of them are **out of date**: they describe a SQLite-only, unauthenticated MVP with legacy code in `src/`. The code is the source of truth. The current state is described below.

## Commands

```bash
npm run dev              # dev server on :3000 (workspace UI at /app, landing page at /)
npm run build
npm run lint             # eslint (flat config)
npx tsc --noEmit         # type check
npm test                 # node --experimental-strip-types --test tests/graph.test.mjs
node --experimental-strip-types --test --test-name-pattern="normalizes a graph" tests/graph.test.mjs   # single test
```

The tests in `tests/graph.test.mjs` import the `.ts` sources in `src/lib`, `src/types` and `src/utils` directly through Node type-stripping. Any module these tests reach must therefore use explicit `.ts` extensions in relative imports (e.g. `import { normalizeGraph } from './graph.ts'`). It also must not use TS-only syntax that type-stripping rejects, such as enums and parameter properties. Route handlers and components use the `@/` alias instead.

## Architecture

### Product model
Synthex Studio is a research workspace built on a typed knowledge graph. Nodes include concept, claim, question, hypothesis, source, note, section/group clusters and others; edges are labeled relationships. The core invariant: **AI never writes directly to the graph.** Research runs produce a `ResearchSession` whose `changes` stay `pending` until the user accepts or rejects each one (`PATCH /api/research/[sessionId]`). Only the accepted subgraph is committed; edges left dangling are dropped. AI-generated claims start with `claimStatus: 'unverified'`.

### Frontend
- `src/app/page.tsx` is the marketing landing page. `src/app/app/page.tsx` is the main workspace (~2.4k lines). It holds all client state: the active project, nodes and edges, undo/redo, modals, and a debounced autosave that sends the whole graph with `PUT /api/graph`.
- `src/components/research/GraphCanvas.tsx` handles pan/zoom, dragging, marquee selection, cluster (section) bounding boxes and folding, and SVG connector routing. Each node type has its own card component in `components/research/nodes/`, and `nodes/index.tsx` dispatches between them.
- `KnowledgeViews.tsx` renders the non-canvas views of the same graph: outline, evidence paths, claims, sources, questions, and history.
- Shared types, including `CanvasNode`, `Connection`, `ResearchSession` and `ONTOLOGY_PRESETS`, live in `src/types/canvas.ts`.

### Graph core (`src/lib/graph.ts`)
This module contains the pure functions: `normalizeGraph` (which rejects duplicate or dangling IDs), `addNode`, `addRelationship`, `removeNode`, `neighborhood`, and the Mermaid and `CONTEXT.md` exporters. Both server routes and tests depend on it. Other pure exporters live in `vault-export.ts` (Obsidian zip), `bibtex.ts` and `canvas-export.ts` (SVG).

### Persistence: dual-mode (`src/lib/db.ts` + `src/lib/neon.ts`)
- If `DATABASE_URL`, `POSTGRES_URL` or `STORAGE_URL` is set (`isNeonConfigured()`), every exported `db.ts` function delegates to its `neon*` counterpart in `neon.ts`, which uses Neon serverless Postgres over HTTP. Otherwise the functions use local SQLite (`canvas.db`, WAL, `better-sqlite3`, loaded lazily through `createRequire`).
- Because of this, db functions return `T | Promise<T>`. **Always `await` them.** Any schema change has to be made in three places: SQLite (`ensureSchemaColumns` / create statements in `db.ts`), Neon's auto-init in `neon.ts`, and `scripts/schema-postgres.sql`.
- Nodes and connections have a composite primary key `(projectId, id)`. Every query is scoped by project.
- Graph revisions (persistent history/restore) are served by `/api/revisions`. SQLite file backups are served by `/api/backup`.

### Auth, tenancy, billing
- `src/middleware.ts` + `src/lib/auth.ts` (`getServerAuth()`) use Clerk **only when** both Clerk keys are set. Without them, requests run as a local user (`local_researcher`, pro tier) and `isLocal: true`.
- The route handler pattern is: `getServerAuth()` → `userHasProjectAccess(projectId, userId, orgId, clerkId)` → return 404 if access is denied.
- AI routes check and deduct "Context Credits" (`src/lib/credits.ts`, `CREDIT_RATES`) before calling models. Stripe subscriptions and top-ups go through `src/lib/stripe.ts`, `/api/billing/*` and `/api/webhooks/stripe`. Clerk user sync goes through `/api/webhooks/clerk`.

### AI and retrieval (server-only)
- AI is provider-abstracted. OpenAI (`gpt-6-luna`) is primary when `OPENAI_API_KEY` is set; Gemini (`gemini-3.8-flash`) is the fallback, or the only provider without an OpenAI key. `src/lib/ai-providers.ts` holds the keys, model IDs, AI SDK model factory and provider selection: after an OpenAI failure, Gemini goes first for a 2-minute cooldown (per instance), then OpenAI is retried. API keys are read only on the server. Never add client-side model calls.
- Chat (`src/lib/ai-chat.ts`) uses the Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/google`): `generateText`/`streamText` with a zod `Output.object` schema that both providers enforce (OpenAI strict mode, so every field is required and nullable). Model tool calls still pass through `sanitizeToolCall` before reaching the client. Routes pass `request.signal`; an abort never triggers a provider fallback. SDK docs ship in `node_modules/ai/docs/` and `node_modules/@ai-sdk/*/docs/`.
- Chat memory: `chat_messages` (SQLite, Neon auto-init, `schema-postgres.sql`) stores each completed exchange per project, user and thread. Threads are private to their user even on shared maps. `/api/ai/chat` loads the thread's recent turns on the server (never from the client) and passes them as `history`; `ai-chat.ts` trims them to a budget, joins the previous question to the retrieval query, and seeds the graph walk with the nodes the previous answer cited (`extraSeedIds`). `GET /api/ai/chat` restores the latest thread. In the workspace, "New chat" starts a new thread and "Save to map" turns an answer into a note linked (`references`) to the ideas it cites.
- Research (`src/lib/ai-research.ts`) uses the same SDK setup with each provider's built-in search tool (`openai.tools.webSearch`, `google.tools.googleSearch`) plus a zod output schema. Quick mode is one grounded call. Deep mode on both providers is: plan 3 search axes → grounded hop 1 → grounded hop 2 on hop 1's open questions; hop 2 cards may link to hop 1 tempIds (hop 2 ids are prefixed `hop2-`, duplicate titles merge). Sources are kept only if the search returned them; if OpenAI rejects the search tool, the run continues without sources and adds a `groundingNote`. Research runs are not aborted on client disconnect, because the finished session is saved to research history. Two more modes share this pipeline and the review flow: `organize` (`/organize`: one schema call with no tools that sorts the user's raw notes into goal, ideas, claims, hunches, open questions and links, adding no outside facts) and `check` (`/check`: organize, then one grounded call that flags outdated specifics and better alternatives, linking back with `contradicts`/`replaces`/`supports`). Both accept up to 6,000 characters (`RESEARCH_INPUT_LIMITS`) and have their own credit rates. `src/lib/ai-service.ts` is now just the entry point: `getAIStatus`, `indexGraphNodes` and re-exports.
- Graph RAG (`src/lib/rag/`): `vector-store.ts` syncs the index and runs hybrid search (RRF over keyword + dense ranks) on a backend chosen like `db.ts`: `search-index-sqlite.ts` (FTS5 + `sqlite-vec`, partitioned by project) or `search-index-neon.ts` (`node_search_index` table: tsvector + pgvector). Embeddings are 1536d from OpenAI `text-embedding-3-small` or Gemini `gemini-embedding-001`; every vector is tagged with its provider and only compared with vectors from the same provider. The keyword index is written even with no AI keys; vector search degrades away when sqlite-vec/pgvector is unavailable. `graph-walker.ts` extracts the reasoning subgraph and `context-builder.ts` assembles a context that fits a token budget. `PUT /api/graph` calls `indexGraphNodes` to keep the index current.
- `graph-analyst.ts` / `graph-organizer.ts` provide AI-assisted analysis and layout of the graph.

### MCP server (offline only)
`POST /api/mcp` (`src/app/api/mcp/route.ts`) is a stateless Streamable HTTP MCP endpoint (`@modelcontextprotocol/sdk`) for AI apps; see `docs/mcp.md`. It is off (404) when Clerk is configured: hosted use needs its own auth first. Tools live in `src/lib/mcp/server.ts`; `src/lib/mcp/build.ts` turns tool input into graph data (tested). `create_map` writes a **new** map directly (agreed exception: it touches no existing work); `propose_changes` only saves a pending `ResearchSession` (mode `mcp`), reviewed like research. No model calls, no credits. `/app?map=<id>` opens a map; the desktop app prefers port 47821 so client configs survive restarts.

### Live collaboration (optional)
`collab-server/` is a separate Hocuspocus (Yjs) relay, deployed on its own (Cloud Run, `--max-instances=1`). It holds open maps in memory only; the database stays the source of truth and every client keeps autosaving the merged map through `PUT /api/graph`. `GET /api/collab/token` does the usual project-access check and signs a 10-minute HMAC token (`src/lib/collab-token.ts`, `COLLAB_SECRET`) bound to one map, which the server verifies. `src/components/collab/useCollaboration.ts` syncs notes and links as two Y.Maps keyed by id (the first client in a room seeds it from its loaded graph), shares presence (cursor, selection, editing), and rebases the undo stack onto teammates' edits so undo only reverts your own. With `COLLAB_SERVER_URL`/`COLLAB_SECRET` unset, everything runs as before. The CSP `connect-src` allows the collab origin.

### Uploads
`POST /api/upload` stores a file in GCS when `GCS_BUCKET_NAME` is set (`storage-gcs.ts`). Otherwise it writes to `public/uploads/{projectId}/`. On read-only serverless filesystems it falls back to an inline data URI. Nodes store only the returned URL. `PUT /api/graph` rejects bodies over 5 MB, so large base64 payloads in nodes will break autosave.

### Security
- Only `/`, sign-in/up, `/api/webhooks/*` and `/uploads/*` are public (`src/middleware.ts`). Webhooks must verify signatures (Stripe `constructEvent`, Clerk `verifyWebhook`) and return 503 when their secret is unset — never parse unsigned payloads.
- `/api/metadata` fetches arbitrary URLs: every hop is checked against a private-range `BlockList`, and the socket uses a pinned DNS lookup (anti-rebinding). Keep both.
- `/api/backup` touches the whole SQLite file, so it's local-mode only.
- AI routes charge credits up front with an atomic conditional `UPDATE` (`deductCredits`) and call `refundCredits` if the AI call fails. Don't reintroduce check-then-deduct.
- `userHasProjectAccess` / `getProjectsFromDb` fail closed when given no identity.
- Return generic messages in 5xx responses; log the real error server-side.
- CSP is set by `clerkMiddleware` (`contentSecurityPolicy` in `src/middleware.ts`); new external image/frame/font hosts must be added there. Other headers live in `next.config.ts`.

## Deployment
The app runs in two targets. The `Dockerfile` and `cloudbuild.yaml` build it for Google Cloud Run (port 8080). On Vercel it uses Neon, and SQLite falls back to `/tmp/canvas.db`. `.env.example` documents all environment variables. Every integration is optional: with only `GEMINI_API_KEY` set, or with nothing at all, the app runs fully offline on SQLite.

## Removed legacy code
The old canvas prototype (client-side Gemini calls, unscoped `/api/nodes|connections|canvas` routes, per-node CRUD in db.ts) was deleted. All writes go through `PUT /api/graph` → `bulkSaveCanvasToDb`. Don't reintroduce per-node write paths.
