# Synthex MCP server: design (offline first)

## Intent

The user wants to talk to an AI in another app (Claude Code, Claude Desktop, Cursor) and say things like
"create a simple project to show what are the types of protein, don't go deep, very fast". The map should
then appear in their Synthex workspace, ready to open. From the same chat they want to list their maps,
read one, and add to it. Their words: "list projects, add new ones, create the graphs or modify existing ones".

Fast and simple matters more than depth. The client's own model does the thinking, so the server calls no
AI model and charges no credits.

## Scope: offline first

Version 1 targets the local app only: the desktop build (`SYNTHEX_DESKTOP=1`) and `npm run dev`. Both run
without Clerk, so every request acts as the local user (`getServerAuth()` → `isLocal`), as all local routes
already do. Hosted use (Clerk, personal access tokens, OAuth for ChatGPT and the Claude Desktop connector
UI) is a later step and is out of scope here.

## Goals

- An MCP endpoint served by the Next app: `POST /api/mcp` (Streamable HTTP, stateless, JSON responses).
- Tools:
  - `list_maps`: id, title, node count, and a link for each map.
  - `read_map(mapId)`: the map as `exportContextMarkdown`, plus node ids so the AI can link to them.
    Over ~200 nodes, return titles and ids only, plus a hint to call `search_map`.
  - `search_map(mapId, query)`: `hybridSearch` (keyword only when no AI keys are set), returning nodes and their 1-hop neighbors.
  - `create_map(title, nodes[], links[])`: creates the map and writes its graph directly. Nodes use
    `tempId` / `type` / `title` / `content` (types: concept, note, claim, question, hypothesis, source with url).
    Links use `from` / `to` / `label` (the research edge labels). Positions come from `hierarchicalLayout`.
    The result returns the new map's id and link.
  - `propose_changes(mapId, summary, nodes[], links[])`: adds to an existing map through review. It builds a
    `ResearchSession` (new mode `mcp`) whose changes are all `pending`. Links may point at existing node ids
    or at new tempIds. The result returns the link to the map, where the user reviews the changes.
- A deep link `/app?map=<id>` that opens that map in the workspace. Today only localStorage picks the map.
- Docs (`docs/mcp.md`) showing how to connect Claude Code, Cursor and Claude Desktop.

## Review rule (decided)

- **New maps skip review.** They touch no existing work. Their nodes are written as `origin: 'ai'`, and AI
  claims start `claimStatus: 'unverified'`. This is a deliberate, scoped exception to "AI never writes
  directly to the graph", agreed with the user for new maps only.
- **Existing maps go through review.** `propose_changes` writes only a pending `ResearchSession`, and the
  existing review UI and `PATCH /api/research/[sessionId]` commit what the user accepts.

## Non-goals (v1)

- Editing or deleting existing nodes. The review flow only supports additions (`ResearchChange` kind
  node | relationship). The tool description says so, and the AI should tell the user.
- Hosted/Clerk mode, tokens, OAuth, team maps. In Clerk mode the route returns 404 until auth is designed.
- A local stdio server. Clients that only speak stdio (Claude Desktop config) use `npx mcp-remote <url>`.
- Calling AI models or charging credits.

## Anti-goals

- No per-node write path. `create_map` saves through `bulkSaveCanvasToDb` (the same function `PUT /api/graph`
  uses), and `propose_changes` goes through `saveResearchSession`.
- Never return raw errors. Tool failures say something generic, and the server log gets the real error.

## Constraints

- Reuse: `normalizeGraph` (validates every graph before saving), `exportContextMarkdown`, `neighborhood`,
  `hybridSearch`, `hierarchicalLayout`, `indexGraphNodes` (after `create_map`), db functions (awaited,
  scoped by project, `userHasProjectAccess` before every read and write).
- Input limits: title ≤ 200 chars, ≤ 60 nodes and ≤ 120 links per call, node content ≤ 12,000 chars,
  following the research route's caps.
- Desktop: the middleware's loopback check already applies. The desktop server's port is random per
  launch, so a client config would break on every restart. The desktop app should prefer a fixed port
  (`47821`) and fall back to a free one, logging the MCP URL.

## How (builder's calls)

- SDK: `@modelcontextprotocol/sdk`, using its web-standard Streamable HTTP transport in stateless mode, with
  one server and transport per request. Tool input schemas use zod (already installed, v4).
- Shared tool logic goes in `src/lib/mcp/` and is not tested through Next. Node-level tests go in
  `tests/mcp.test.mjs` for the pure parts: converting tool input to a normalized graph or session, plus layout.
- Verify with a real client: `claude mcp add --transport http synthex http://localhost:3000/api/mcp`, then
  create the protein map (`protein-types-map.json` in the parent checkout shows the expected shape).
