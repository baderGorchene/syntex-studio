import type { CanvasNode, Connection } from '../../types/canvas.ts';
import { normalizeGraph } from '../graph.ts';
import type { GraphConflict, GraphSnapshot } from './merge.ts';

// Applies the user's answer to one merge conflict. Pure; the result always passes normalizeGraph.
export type ResolutionChoice = 'mine' | 'cloud' | 'both' | 'keep' | 'delete';

const VALID: Record<string, ResolutionChoice[]> = {
  'title:both-changed': ['mine', 'cloud'],
  'node:both-changed': ['mine', 'cloud', 'both'],
  'edge:both-changed': ['mine', 'cloud'],
  'node:deleted-local': ['keep', 'delete'],
  'node:deleted-remote': ['keep', 'delete'],
  'edge:deleted-local': ['keep', 'delete'],
  'edge:deleted-remote': ['keep', 'delete'],
};

/** Replaces (or adds) an item by id. */
const upsert = <T extends { id: string }>(items: T[], item: T) => [...items.filter(i => i.id !== item.id), item];

export function applyResolution(merged: GraphSnapshot, conflict: GraphConflict, choice: ResolutionChoice, newId: () => string): GraphSnapshot {
  if (!VALID[`${conflict.kind}:${conflict.reason}`]?.includes(choice)) {
    throw new Error(`Invalid resolution "${choice}" for a ${conflict.kind} conflict (${conflict.reason}).`);
  }
  let { title, nodes, relationships } = merged;
  const id = conflict.itemId;

  if (conflict.kind === 'title') {
    title = (choice === 'mine' ? conflict.local : conflict.remote) as string;
  } else if (choice === 'delete') {
    if (conflict.kind === 'node') {
      nodes = nodes.filter(n => n.id !== id);
      relationships = relationships.filter(e => e.from !== id && e.to !== id);
    } else {
      relationships = relationships.filter(e => e.id !== id);
    }
  } else if (conflict.kind === 'node') {
    const local = conflict.local as CanvasNode | undefined;
    const remote = conflict.remote as CanvasNode | undefined;
    if (choice === 'keep') {
      nodes = upsert(nodes, (local ?? remote)!);
      const nodeIds = new Set(nodes.map(n => n.id));
      const edgeIds = new Set(relationships.map(e => e.id));
      const restorable = (conflict.edges ?? []).filter(e => nodeIds.has(e.from) && nodeIds.has(e.to) && !edgeIds.has(e.id));
      relationships = [...relationships, ...restorable];
    } else if (choice === 'both') {
      nodes = [...upsert(nodes, local!), { ...remote!, id: newId(), title: `${remote!.title} (conflict copy)` }];
    } else {
      nodes = upsert(nodes, (choice === 'mine' ? local : remote)!);
    }
  } else {
    // Edge: mine/cloud on both-changed, keep on deleted-*. Left out while an endpoint is missing;
    // a kept endpoint node brings its links back through its own conflict's `edges`.
    const edge = (choice === 'keep' ? conflict.local ?? conflict.remote : choice === 'mine' ? conflict.local : conflict.remote) as Connection;
    const nodeIds = new Set(nodes.map(n => n.id));
    relationships = relationships.filter(e => e.id !== id);
    if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) relationships = [...relationships, edge];
  }

  normalizeGraph(nodes, relationships); // throws on duplicate or dangling ids
  return { title, nodes, relationships };
}
