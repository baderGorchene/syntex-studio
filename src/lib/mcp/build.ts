// Turns MCP tool input (cards with tempIds, links between them) into graph data. Pure, so tests load it through
// type-stripping. New maps become nodes and connections; additions to an existing map become a pending ResearchSession.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizeGraph, strokeForLabel, type KnowledgeGraph } from '../graph.ts';
import { hierarchicalLayout } from '../graph-organizer.ts';
import type { CanvasNode, Connection, ResearchChange, ResearchSession } from '../../types/canvas';

export const MAP_LIMITS = { title: 200, nodes: 60, links: 120, content: 12000 };

export const NODE_TYPES = ['concept', 'note', 'claim', 'question', 'hypothesis', 'source'] as const;
export const EDGE_LABELS = [
  'related_to', 'supports', 'contradicts', 'derived_from', 'depends_on', 'example_of', 'part_of',
  'causes', 'enables', 'similar_to', 'references', 'answers', 'challenges', 'extends', 'replaces'
];

export const nodeInputSchema = z.object({
  tempId: z.string().min(1).max(100).describe('Your own short id for this card, used by links in the same call.'),
  type: z.enum(NODE_TYPES),
  title: z.string().min(1).max(500),
  content: z.string().max(MAP_LIMITS.content).optional(),
  url: z.string().max(4096).optional().describe('For type "source": the http(s) address.')
});
export const linkInputSchema = z.object({
  from: z.string().min(1).max(200).describe('A tempId from this call, or an existing node id.'),
  to: z.string().min(1).max(200),
  label: z.string().max(60).describe(`One of: ${EDGE_LABELS.join(', ')}.`)
});
export type NodeInput = z.infer<typeof nodeInputSchema>;
export type LinkInput = z.infer<typeof linkInputSchema>;

const COLORS: Partial<Record<CanvasNode['type'], CanvasNode['color']>> = { question: 'terracotta', claim: 'neutral', source: 'sage' };

function httpUrl(value?: string): string | null {
  try {
    const url = new URL(value || '');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Cards → nodes keyed by tempId. Duplicates are dropped; a source without a usable url becomes a note. */
function toNodes(inputs: NodeInput[], now: number, dropped: string[]): Map<string, CanvasNode> {
  const byTempId = new Map<string, CanvasNode>();
  for (const input of inputs.slice(0, MAP_LIMITS.nodes)) {
    const title = input.title.trim().slice(0, 500);
    if (!title || byTempId.has(input.tempId)) {
      dropped.push(`card "${input.tempId}" (duplicate or empty)`);
      continue;
    }
    const url = input.type === 'source' ? httpUrl(input.url) : null;
    const type: CanvasNode['type'] = input.type === 'source' && !url ? 'note' : input.type;
    byTempId.set(input.tempId, {
      id: `mcp-${randomUUID()}`, type, x: 0, y: 0,
      width: type === 'question' ? 300 : 280,
      color: COLORS[type] || 'cobalt',
      title,
      content: (input.content || '').slice(0, MAP_LIMITS.content),
      ...(url ? { url, domain: new URL(url).hostname } : {}),
      createdAt: now,
      metadata: { origin: 'ai', ...(type === 'claim' ? { claimStatus: 'unverified' as const } : {}) }
    });
  }
  return byTempId;
}

/** Links whose ends resolve (tempId first, then an existing node id). Unknown ends and self-links are dropped. */
function toConnections(inputs: LinkInput[], resolve: (ref: string) => string | undefined, dropped: string[]): Connection[] {
  return inputs.slice(0, MAP_LIMITS.links).flatMap(input => {
    const from = resolve(input.from);
    const to = resolve(input.to);
    if (!from || !to || from === to) {
      dropped.push(`link ${input.from} → ${input.to} (unknown card)`);
      return [];
    }
    const proposed = input.label.trim().toLowerCase().replace(/\s+/g, '_');
    const label = EDGE_LABELS.includes(proposed) ? proposed : 'related_to';
    return [{
      id: `mcp-edge-${randomUUID()}`, from, to, label,
      color: 'neutral', arrowhead: 'end', lineStyle: 'curved', strokePattern: strokeForLabel(label), animated: false,
      metadata: { origin: 'ai' }
    } satisfies Connection];
  });
}

/** Lays the nodes out with the workspace's hierarchical layout, offset by (dx, dy). */
function layOut(nodes: CanvasNode[], connections: Connection[], dx = 0, dy = 0): CanvasNode[] {
  const positions = new Map(hierarchicalLayout(normalizeGraph(nodes, connections)).map(p => [p.id, p]));
  return nodes.map(node => {
    const p = positions.get(node.id);
    return p ? { ...node, x: p.x + dx, y: p.y + dy } : node;
  });
}

export function buildNewMap(nodeInputs: NodeInput[], linkInputs: LinkInput[], now = Date.now()) {
  const dropped: string[] = [];
  const byTempId = toNodes(nodeInputs, now, dropped);
  const connections = toConnections(linkInputs, ref => byTempId.get(ref)?.id, dropped);
  const nodes = layOut([...byTempId.values()], connections);
  normalizeGraph(nodes, connections); // throws on anything the save path would reject
  return { nodes, connections, dropped };
}

/** Additions to an existing map, staged as a pending review placed to the right of what is already there. */
export function buildProposal(graph: KnowledgeGraph, summary: string, nodeInputs: NodeInput[], linkInputs: LinkInput[], now = Date.now()) {
  const dropped: string[] = [];
  const byTempId = toNodes(nodeInputs, now, dropped);
  const connections = toConnections(linkInputs, ref => byTempId.get(ref)?.id ?? (graph.nodesById[ref] ? ref : undefined), dropped);
  const existing = Object.values(graph.nodesById);
  const right = existing.length ? Math.max(...existing.map(node => node.x + (node.width || 280))) + 120 : 0;
  const top = existing.length ? Math.min(...existing.map(node => node.y)) : 0;
  const newIds = new Set([...byTempId.values()].map(node => node.id));
  const nodes = layOut([...byTempId.values()], connections.filter(edge => newIds.has(edge.from) && newIds.has(edge.to)), right, top);
  const changes: ResearchChange[] = [
    ...nodes.map(payload => ({ id: randomUUID(), kind: 'node' as const, payload, status: 'pending' as const })),
    ...connections.map(payload => ({ id: randomUUID(), kind: 'relationship' as const, payload, status: 'pending' as const }))
  ];
  const session: ResearchSession = {
    id: randomUUID(), query: summary.slice(0, 500), mode: 'mcp', status: 'review',
    summary: summary.slice(0, 6000),
    trail: [`Proposed from an AI app over MCP: ${nodes.length} cards and ${connections.length} links, pending your review`],
    changes,
    createdAt: now
  };
  return { session, dropped };
}
