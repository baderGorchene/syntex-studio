# Connect an AI app to Synthex (MCP)

Synthex exposes an MCP server so an AI app (Claude Code, Cursor, Claude Desktop) can list, read, search and
create your maps. For now it works with the **offline/local app only**: the desktop app or `npm run dev`
without Clerk keys. On a hosted (Clerk) deployment the endpoint is off.

| Running | MCP address |
|---|---|
| Desktop app | `http://127.0.0.1:47821/api/mcp` (if 47821 is taken, the app logs the port it used) |
| `npm run dev` | `http://localhost:3000/api/mcp` |

Synthex has to be running while you use it.

## What the AI can do

| Tool | What it does |
|---|---|
| `list_maps` | Your maps, with ids and links |
| `read_map` | A map's cards and links, with card ids |
| `search_map` | Cards matching a query, plus what they link to |
| `create_map` | A new map with its cards and links, **saved straight away** |
| `propose_changes` | Cards and links added to an existing map, **waiting for your review** |

Additions to an existing map show up as drafts on that map ("Review one by one" / "Keep all"). The AI's
reply links to the map (`/app?map=<id>`). It cannot edit or delete cards you already have. Synthex makes no
AI calls of its own here, so no credits are used.

## Claude Code

```bash
claude mcp add --transport http synthex http://127.0.0.1:47821/api/mcp
```

## Cursor

`~/.cursor/mcp.json`:

```json
{ "mcpServers": { "synthex": { "url": "http://127.0.0.1:47821/api/mcp" } } }
```

## Claude Desktop

Claude Desktop's config file only starts local programs, so bridge with `mcp-remote` (needs Node).
Settings → Developer → Edit Config:

```json
{
  "mcpServers": {
    "synthex": { "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:47821/api/mcp"] }
  }
}
```

Restart Claude Desktop, then ask something like: *"Create a simple Synthex map of the types of protein, keep it quick."*

## Not yet

Hosted Synthex (personal access tokens, or OAuth for ChatGPT and Claude's connector screen), team maps,
and editing existing cards.
