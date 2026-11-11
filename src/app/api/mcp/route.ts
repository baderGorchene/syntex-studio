import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { getServerAuth, isClerkConfigured } from '@/lib/auth';
import { createSynthexMcpServer } from '@/lib/mcp/server';

// MCP for AI apps (Claude Code, Cursor, Claude Desktop via mcp-remote). Offline/local mode only for now:
// hosted use needs its own auth (tokens or OAuth), so with Clerk configured this route does not exist.
// Stateless: a fresh server and transport per request, JSON responses, no sessions to keep.
export async function POST(request: Request) {
  if (isClerkConfigured()) return Response.json({ error: 'Not found.' }, { status: 404 });
  try {
    const auth = await getServerAuth();
    const server = createSynthexMcpServer(auth, new URL(request.url).origin);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    console.error('MCP request failed:', error);
    return Response.json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error.' }, id: null }, { status: 500 });
  }
}

// No server-initiated streams or sessions in stateless mode.
export function GET() {
  return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { Allow: 'POST' } });
}
export const DELETE = GET;
