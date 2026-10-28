# Synthex MCP server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An offline-mode MCP endpoint (`/api/mcp`) that lists, reads, searches and creates maps, and proposes reviewed additions to existing maps.

**Architecture:** Pure input→graph/session builders in `src/lib/mcp/build.ts` (tested via type-stripping). `src/lib/mcp/server.ts` registers the tools on an `McpServer` and calls db/RAG. `src/app/api/mcp/route.ts` runs a stateless web-standard Streamable HTTP transport per request.

**Tech Stack:** `@modelcontextprotocol/sdk`, zod 4, Next 16 route handlers, existing db/graph/RAG modules.

**Spec:** `docs/superpowers/specs/2026-10-28-mcp-server-design.md`

## Global Constraints

- Local mode only: in Clerk mode (`isClerkConfigured()`), `/api/mcp` answers 404.
- Caps: title ≤ 200 chars, ≤ 60 nodes and ≤ 120 links per call, node content ≤ 12,000 chars.
- Node types accepted: concept, note, claim, question, hypothesis, source (with `url`). Link labels: the research route's `edgeLabels` set.
- AI nodes carry `metadata.origin: 'ai'`. Claims carry `claimStatus: 'unverified'`.
- No model calls and no credits. Tool errors are generic, and the real error goes to `console.error`.
- Writes: `create_map` → `createProjectInDb` + `bulkSaveCanvasToDb` + `indexGraphNodes`. `propose_changes` → `saveResearchSession` only.
- Modules reached by tests use `.ts` relative imports.

## Review Focus

1. A link names a tempId or node id that doesn't exist: drop it, and report it in the tool result. Never fail the whole map.
2. Duplicate tempIds in one call: keep the first, drop the rest.
3. `propose_changes` on a map id that doesn't exist or isn't the user's: generic "Map not found."
4. Proposal nodes must not overlap existing nodes: place them to the right of the map's bounding box.
5. A source without a valid http(s) url: becomes a note.

---

### Task 1: Pure builders

**Files:** Create `src/lib/mcp/build.ts`. Test: `tests/graph.test.mjs` (append).

**Interfaces (produces):**
- `MAP_LIMITS = { title: 200, nodes: 60, links: 120, content: 12000 }`
- `nodeInputSchema`, `linkInputSchema` (zod object shapes: `{ tempId, type, title, content?, url? }`, `{ from, to, label }`), plus `EDGE_LABELS: string[]`
- `buildNewMap(nodes: NodeInput[], links: LinkInput[], now?: number): { nodes: CanvasNode[]; connections: Connection[]; dropped: string[] }`: ids `mcp-<uuid>`, positions from `hierarchicalLayout(normalizeGraph(...))`, result passes `normalizeGraph`
- `buildProposal(graph: KnowledgeGraph, summary: string, nodes, links, now?): { session: ResearchSession; dropped: string[] }`: `mode: 'mcp'`, `status: 'review'`, every change `pending`. A link endpoint may be a new tempId or an existing node id.

- [ ] Write tests:
  - `builds a new map from tool input`: 3 nodes and 2 links, plus 1 link to `ghost` → 3 nodes, 2 connections, `dropped.length === 1`, every node has finite x/y and `origin === 'ai'`, the claim is `unverified`, and `normalizeGraph` doesn't throw.
  - `drops duplicate tempIds and downgrades a source without url`.
  - `builds a pending proposal that can link to existing nodes`: graph has `a` at x=0. Proposal adds node `n1` and link `n1→a` → 2 changes, all pending, and the node's x is greater than a's x + width.
- [ ] Run `npm test`. Expect a FAIL (module missing).
- [ ] Implement `build.ts`.
- [ ] Run `npm test`. Expect a PASS.
- [ ] Add `'mcp'` support to types: `SessionMode = ResearchMode | 'mcp'` in `src/types/canvas.ts`, `ResearchSession.mode: SessionMode`, `RESEARCH_MODE_LABELS: Record<SessionMode,string>` with `mcp: 'From an AI app'`. Then run `npx tsc --noEmit`.
- [ ] Commit.

### Task 2: MCP server and route

**Files:** Create `src/lib/mcp/server.ts` and `src/app/api/mcp/route.ts`. Modify `package.json` (add `@modelcontextprotocol/sdk`).

**Interfaces:** `createSynthexMcpServer(auth: AuthContext, baseUrl: string): McpServer`, with tools `list_maps`, `read_map`, `search_map`, `create_map`, `propose_changes` as described in the spec. Links are `${baseUrl}/app?map=<id>`. The route exports `POST`, plus `GET`/`DELETE` → 405.

- [ ] Install the SDK and check that the web-standard transport is in its exports.
- [ ] Implement the server. Every tool except `create_map` first checks `userHasProjectAccess(mapId, userId, null, clerkId)`. `read_map` over 200 nodes returns only `- title (id)` lines.
- [ ] Implement the route: Clerk configured → 404. Otherwise `getServerAuth()`, build the server and transport (`sessionIdGenerator: undefined, enableJsonResponse: true`), and return `transport.handleRequest(request)`.
- [ ] Smoke test with curl against `npm run dev` (blank env keys): send `initialize` and `tools/list`.
- [ ] Run tsc and lint, then commit.

### Task 3: Deep link and desktop port

**Files:** Modify `src/app/app/page.tsx` (`projectId` initializer) and `electron/main.cjs` (`freePort`).

- [ ] page.tsx: if `?map=` is present (≤ 80 chars), write it to `synthex_active_project_id`, then strip it with `history.replaceState`.
- [ ] main.cjs: try port `47821` first and fall back to port 0.
- [ ] Check with the browser: `/app?map=<id>` opens that map.
- [ ] Commit.

### Task 4: Real client test and docs

**Files:** Create `docs/mcp.md`. Modify `CLAUDE.md` (one paragraph).

- [ ] Run `claude mcp add --transport http synthex-test http://localhost:3000/api/mcp` with `claude -p` against the dev server, and ask it to create the protein map, then propose one addition. Check the map and its pending session through the API, then remove the test MCP entry.
- [ ] Write docs: Claude Code, Cursor (`url`), and Claude Desktop (`npx mcp-remote`), covering the desktop app (port 47821) and dev (port 3000).
- [ ] Run `npm test`, `npx tsc --noEmit` and `npm run lint`. All must pass. Commit.
