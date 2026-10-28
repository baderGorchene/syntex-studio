// Synthex tools for AI apps over MCP. The client's model does the thinking: no model calls and no credits here.
// New maps are written directly (they touch no existing work); additions to an existing map are staged as a
// pending ResearchSession the user reviews in the workspace.
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthContext } from '@/lib/auth';
import { indexGraphNodes } from '@/lib/ai-service';
import {
  bulkSaveCanvasToDb,
  createProjectInDb,
  deleteProjectFromDb,
  getAllConnectionsFromDb,
  getAllNodesFromDb,
  getProjectsFromDb,
  getProjectTitle,
  saveResearchSession,
  userHasProjectAccess
} from '@/lib/db';
import { exportContextMarkdown, neighborhood, normalizeGraph } from '@/lib/graph';
import { hybridSearch } from '@/lib/rag/vector-store';
import { buildNewMap, buildProposal, linkInputSchema, MAP_LIMITS, nodeInputSchema } from '@/lib/mcp/build';
import type { CanvasNode, Connection } from '@/types/canvas';

const READ_FULL_LIMIT = 200;

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const failure = (value: string) => ({ ...text(value), isError: true });
const droppedNote = (dropped: string[]) => dropped.length ? `\nSkipped: ${dropped.slice(0, 10).join('; ')}${dropped.length > 10 ? '…' : ''}` : '';

export function createSynthexMcpServer(auth: AuthContext, baseUrl: string): McpServer {
  const userId = auth.user?.id || auth.userId;
  const link = (mapId: string) => `${baseUrl}/app?map=${encodeURIComponent(mapId)}`;
  const server = new McpServer({ name: 'synthex-studio', version: '1.0.0' }, {
    instructions: 'Synthex Studio holds the user\'s research maps: cards (concepts, notes, claims, questions, hypotheses, sources) joined by labeled links. ' +
      'Use create_map for a new topic; keep maps small and clear unless asked to go deep. ' +
      'Use propose_changes to add to an existing map: the additions wait for the user to accept them in Synthex, so give them the link. ' +
      'Existing cards cannot be edited or deleted from here.'
  });

  async function loadGraph(mapId: string) {
    if (mapId.length > 80 || !(await userHasProjectAccess(mapId, userId, null, auth.clerkId))) return null;
    return normalizeGraph((await getAllNodesFromDb(mapId)) as CanvasNode[], (await getAllConnectionsFromDb(mapId)) as Connection[]);
  }

  // Every tool logs the real error and tells the client something generic.
  function tool<A>(name: string, fn: (args: A) => Promise<ReturnType<typeof text>>) {
    return async (args: A) => {
      try {
        return await fn(args);
      } catch (error) {
        console.error(`MCP tool ${name} failed:`, error);
        return failure('Synthex could not complete that. Try again in a moment.');
      }
    };
  }

  server.registerTool('list_maps', {
    title: 'List maps',
    description: 'List the user\'s personal Synthex maps with their ids and links.',
    annotations: { readOnlyHint: true }
  }, tool('list_maps', async () => {
    const projects = await getProjectsFromDb(userId, null, auth.clerkId);
    if (!projects.length) return text('No maps yet.');
    return text(projects.map(p => `- ${p.title} (id: ${p.id}) ${link(p.id)}`).join('\n'));
  }));

  server.registerTool('read_map', {
    title: 'Read a map',
    description: `Read a map's cards and links as Markdown, with card ids you can link to. Maps over ${READ_FULL_LIMIT} cards list titles only; use search_map for detail.`,
    inputSchema: { mapId: z.string().min(1).max(80) },
    annotations: { readOnlyHint: true }
  }, tool('read_map', async ({ mapId }: { mapId: string }) => {
    const graph = await loadGraph(mapId);
    if (!graph) return failure('Map not found.');
    const title = (await getProjectTitle(mapId)) || 'Untitled map';
    const nodes = Object.values(graph.nodesById);
    if (nodes.length > READ_FULL_LIMIT) {
      return text(`# ${title}\n${nodes.length} cards (titles only):\n${nodes.map(n => `- ${n.title} (id: ${n.id})`).join('\n')}`);
    }
    const ids = nodes.map(n => `- ${n.title} (id: ${n.id}, ${n.type})`).join('\n');
    return text(`${exportContextMarkdown(graph, title)}\n\n## Card ids\n${ids}\n\nOpen: ${link(mapId)}`);
  }));

  server.registerTool('search_map', {
    title: 'Search a map',
    description: 'Find the cards in a map that match a query, with the cards linked to them.',
    inputSchema: { mapId: z.string().min(1).max(80), query: z.string().min(1).max(500) },
    annotations: { readOnlyHint: true }
  }, tool('search_map', async ({ mapId, query }: { mapId: string; query: string }) => {
    const graph = await loadGraph(mapId);
    if (!graph) return failure('Map not found.');
    const hits = (await hybridSearch(mapId, query, 8)).filter(hit => graph.nodesById[hit.nodeId]);
    if (!hits.length) return text('No matching cards.');
    return text(hits.map(hit => {
      const node = graph.nodesById[hit.nodeId];
      const near = [...neighborhood(graph, node.id, 1)].filter(id => id !== node.id).map(id => graph.nodesById[id]?.title).filter(Boolean);
      return `- ${node.title} (id: ${node.id}, ${node.type})${node.content ? `\n  ${node.content.slice(0, 400)}` : ''}${near.length ? `\n  linked to: ${near.slice(0, 8).join(', ')}` : ''}`;
    }).join('\n'));
  }));

  server.registerTool('create_map', {
    title: 'Create a map',
    description: `Create a new map with its cards and links. It is saved straight away. Up to ${MAP_LIMITS.nodes} cards and ${MAP_LIMITS.links} links.`,
    inputSchema: {
      title: z.string().min(2).max(80),
      nodes: z.array(nodeInputSchema).min(1).max(MAP_LIMITS.nodes),
      links: z.array(linkInputSchema).max(MAP_LIMITS.links).default([])
    }
  }, tool('create_map', async ({ title, nodes: nodeInputs, links }: { title: string; nodes: z.infer<typeof nodeInputSchema>[]; links: z.infer<typeof linkInputSchema>[] }) => {
    const { nodes, connections, dropped } = buildNewMap(nodeInputs, links);
    const project = await createProjectInDb(`project-${randomUUID()}`, title.trim(), userId, null);
    try {
      const saved = await bulkSaveCanvasToDb(nodes, connections, project.id);
      if (!saved.saved) throw new Error('Save of the new map was refused.');
    } catch (error) {
      // Never leave an empty half-made map behind.
      await Promise.resolve(deleteProjectFromDb(project.id, userId, auth.clerkId)).catch(e => console.error('Failed to clean up MCP map:', e));
      throw error;
    }
    try { indexGraphNodes(project.id, nodes); } catch (error) { console.warn('Could not index the MCP map:', error); }
    return text(`Created "${project.title}" with ${nodes.length} cards and ${connections.length} links (id: ${project.id}).\nOpen: ${link(project.id)}${droppedNote(dropped)}`);
  }));

  server.registerTool('propose_changes', {
    title: 'Propose additions to a map',
    description: 'Add cards and links to an existing map. They wait as suggestions until the user accepts them in Synthex. ' +
      'Links may join new cards (by tempId) to existing cards (by id from read_map or search_map). Existing cards cannot be edited or removed.',
    inputSchema: {
      mapId: z.string().min(1).max(80),
      summary: z.string().min(1).max(2000).describe('One or two sentences on what these additions are.'),
      nodes: z.array(nodeInputSchema).max(MAP_LIMITS.nodes).default([]),
      links: z.array(linkInputSchema).max(MAP_LIMITS.links).default([])
    }
  }, tool('propose_changes', async ({ mapId, summary, nodes, links }: { mapId: string; summary: string; nodes: z.infer<typeof nodeInputSchema>[]; links: z.infer<typeof linkInputSchema>[] }) => {
    const graph = await loadGraph(mapId);
    if (!graph) return failure('Map not found.');
    const { session, dropped } = buildProposal(graph, summary, nodes, links);
    if (!session.changes.length) return failure(`Nothing to add.${droppedNote(dropped)}`);
    await saveResearchSession(session, mapId);
    const cards = session.changes.filter(c => c.kind === 'node').length;
    return text(`Proposed ${cards} cards and ${session.changes.length - cards} links. They are waiting for review in Synthex: ${link(mapId)}${droppedNote(dropped)}`);
  }));

  return server;
}
