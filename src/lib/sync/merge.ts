import type { CanvasNode, Connection } from '../../types/canvas.ts';
import { normalizeGraph } from '../graph.ts';

// Three-way merge of a map (spec §5). Pure: shared by the desktop sync engine and web autosave.
// Rule of thumb: nothing is silently lost. When unsure, report a conflict instead of picking a side.

export interface GraphSnapshot { title: string; nodes: CanvasNode[]; relationships: Connection[] }
export type ConflictReason = 'both-changed' | 'deleted-local' | 'deleted-remote';
export interface GraphConflict {
  id: string;                        // `${kind}:${itemId}`, stable for resolution
  kind: 'node' | 'edge' | 'title' | 'project';   // 'project' comes from the sync engine, never from mergeGraphs
  itemId: string;                    // node/edge id; 'title' for a title conflict (the snapshot has no projectId)
  reason: ConflictReason;
  base?: CanvasNode | Connection | string;
  local?: CanvasNode | Connection | string;
  remote?: CanvasNode | Connection | string;
  // Node conflicts with deleted-local/deleted-remote only: links touching the node on the side that kept it,
  // left out of merged. Restored if the user keeps the node.
  edges?: Connection[];
}
export interface MergeResult { merged: GraphSnapshot; conflicts: GraphConflict[]; dropped: string[] }

/** JSON with sorted object keys, so key order never counts as a change. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

const CONFLICT = Symbol('conflict');

/** Classic three-way pick: whichever side changed wins; both changed differently is a conflict. */
function pick3<T>(base: T | undefined, local: T, remote: T): T | typeof CONFLICT {
  if (same(local, remote) || same(base, remote)) return local;
  if (same(base, local)) return remote;
  return CONFLICT;
}

// Layout never conflicts: when both sides moved/resized/folded, local wins.
type Layout = { x: number; y: number; width?: number; height?: number; collapsed?: unknown };
const LAYOUT_KEYS = ['x', 'y', 'width', 'height', 'collapsed'] as const;

type NodeContent = Omit<CanvasNode, 'x' | 'y' | 'width' | 'height' | 'sectionId'>;

/** Splits a node into the three parts that merge independently. */
function splitNode(node: CanvasNode): { content: NodeContent; sectionId?: string; layout: Layout } {
  const { x, y, width, height, sectionId, metadata, ...rest } = node;
  const { collapsed, ...meta } = metadata ?? {};
  // Drop metadata that held only `collapsed`, so folding never looks like a content change.
  const content: NodeContent = Object.keys(meta).length ? { ...rest, metadata: meta } : rest;
  const layout: Layout = { x, y, width, height, collapsed };
  return { content, sectionId, layout };
}

function joinNode(content: NodeContent, sectionId: string | undefined, layout: Layout): CanvasNode {
  const { collapsed, ...position } = layout;
  const metadata = collapsed === undefined ? content.metadata : { ...content.metadata, collapsed };
  const node = { ...content, ...position, sectionId, metadata };
  return Object.fromEntries(Object.entries(node).filter(([, value]) => value !== undefined)) as unknown as CanvasNode;
}

/** Node present on both sides (or added on both with the same id). */
function mergeNodeVersions(base: CanvasNode | undefined, local: CanvasNode, remote: CanvasNode): CanvasNode | typeof CONFLICT {
  const b = base && splitNode(base);
  const l = splitNode(local);
  const r = splitNode(remote);
  const content = pick3(b?.content, l.content, r.content);
  const sectionId = pick3(b?.sectionId, l.sectionId, r.sectionId);
  if (content === CONFLICT || sectionId === CONFLICT) return CONFLICT;

  const layout = { ...l.layout };
  for (const key of LAYOUT_KEYS) {
    const value = pick3(b?.layout[key], l.layout[key], r.layout[key]);
    if (value !== CONFLICT) (layout as Record<string, unknown>)[key] = value;
  }
  return joinNode(content, sectionId, layout);
}

/** Content (layout excluded) of a node, for "did this side really change it?" checks. */
const nodeContentKey = (node: CanvasNode) => {
  const { content, sectionId } = splitNode(node);
  return stableStringify({ content, sectionId });
};

/** Applies the spec §5 table to one item. `changed` decides whether a surviving side edited it since base. */
function mergeItem<T extends CanvasNode | Connection>(
  kind: 'node' | 'edge',
  base: T | undefined,
  local: T | undefined,
  remote: T | undefined,
  changed: (item: T, base: T, side: 'local' | 'remote') => boolean,
  mergeBoth: (base: T | undefined, local: T, remote: T) => T | typeof CONFLICT
): { item?: T; conflict?: GraphConflict } {
  const itemId = (base ?? local ?? remote)!.id;
  const conflict = (reason: ConflictReason): GraphConflict => ({ id: `${kind}:${itemId}`, kind, itemId, reason, base, local, remote });

  if (!local && !remote) return {};
  if (base && !local) return changed(remote!, base, 'remote') ? { conflict: conflict('deleted-local') } : {};
  if (base && !remote) return changed(local!, base, 'local') ? { item: local, conflict: conflict('deleted-remote') } : {};
  if (!local || !remote) return { item: local ?? remote };

  const merged = mergeBoth(base, local, remote);
  return merged === CONFLICT ? { item: local, conflict: conflict('both-changed') } : { item: merged };
}

const byId = <T extends { id: string }>(items: T[]) => new Map(items.map(item => [item.id, item]));
const unionIds = (...maps: Map<string, unknown>[]) => [...new Set(maps.flatMap(map => [...map.keys()]))];

export function mergeGraphs(base: GraphSnapshot, local: GraphSnapshot, remote: GraphSnapshot): MergeResult {
  const conflicts: GraphConflict[] = [];

  const baseEdges = byId(base.relationships);
  const localEdges = byId(local.relationships);
  const remoteEdges = byId(remote.relationships);

  // Nodes a side linked to with a new or changed edge. Deleting such a node on the other side is a conflict.
  const newlyLinked = (edges: Connection[]) => new Set(
    edges.filter(e => !same(e, baseEdges.get(e.id))).flatMap(e => [e.from, e.to])
  );
  const linked = { local: newlyLinked(local.relationships), remote: newlyLinked(remote.relationships) };

  const baseNodes = byId(base.nodes);
  const localNodes = byId(local.nodes);
  const remoteNodes = byId(remote.nodes);
  const nodes: CanvasNode[] = [];
  const conflictedNodes = new Set<string>();
  for (const id of unionIds(localNodes, remoteNodes, baseNodes)) {
    const { item, conflict } = mergeItem(
      'node', baseNodes.get(id), localNodes.get(id), remoteNodes.get(id),
      (node, baseNode, side) => nodeContentKey(node) !== nodeContentKey(baseNode) || linked[side].has(id),
      mergeNodeVersions
    );
    if (item) nodes.push(item);
    if (conflict) { conflicts.push(conflict); conflictedNodes.add(id); }
  }

  const nodeIds = new Set(nodes.map(n => n.id));
  const relationships: Connection[] = [];
  const dropped: string[] = [];
  for (const id of unionIds(localEdges, remoteEdges, baseEdges)) {
    const { item, conflict } = mergeItem(
      'edge', baseEdges.get(id), localEdges.get(id), remoteEdges.get(id),
      (e, baseEdge) => !same(e, baseEdge),
      pick3
    );
    if (conflict) conflicts.push(conflict);
    if (!item) continue;
    if (nodeIds.has(item.from) && nodeIds.has(item.to)) { relationships.push(item); continue; }
    // Dangling. If a conflict covers it (its own, or one on an endpoint) the conflict keeps it; otherwise report it.
    if (!conflict && !conflictedNodes.has(item.from) && !conflictedNodes.has(item.to)) dropped.push(id);
  }

  const title = pick3(base.title, local.title, remote.title);
  if (title === CONFLICT) {
    conflicts.push({ id: 'title:title', kind: 'title', itemId: 'title', reason: 'both-changed', base: base.title, local: local.title, remote: remote.title });
  }

  // A delete conflict keeps the links that the kept side has on the node, so choosing "keep" loses nothing.
  const mergedEdgeIds = new Set(relationships.map(e => e.id));
  const parkedEdgeIds = new Set<string>();
  for (const conflict of conflicts) {
    if (conflict.kind !== 'node' || conflict.reason === 'both-changed') continue;
    const keptSide = conflict.reason === 'deleted-local' ? remote : local;
    conflict.edges = keptSide.relationships.filter(e =>
      (e.from === conflict.itemId || e.to === conflict.itemId) && !mergedEdgeIds.has(e.id)
    );
    conflict.edges.forEach(e => parkedEdgeIds.add(e.id));
  }
  const reallyDropped = dropped.filter(id => !parkedEdgeIds.has(id));

  const merged = { title: title === CONFLICT ? local.title : title, nodes, relationships };
  normalizeGraph(merged.nodes, merged.relationships); // throws if the merge ever produced an invalid graph
  return { merged, conflicts, dropped: reallyDropped };
}

/** Same map regardless of node/edge order and object key order. */
export function sameGraph(a: GraphSnapshot, b: GraphSnapshot): boolean {
  const key = (items: unknown[]) => items.map(stableStringify).sort().join('\n');
  return a.title === b.title && key(a.nodes) === key(b.nodes) && key(a.relationships) === key(b.relationships);
}
