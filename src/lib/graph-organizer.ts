import type { CanvasNode } from '../types/canvas';
import type { KnowledgeGraph } from './graph.ts';
import type { PositionDelta } from '../types/chat-tools';

export interface LayoutOptions {
  startX?: number;
  startY?: number;
  columnSpacing?: number;
  /** Gap left under each card. */
  rowGap?: number;
  /** Measured card heights by node id. A card without one falls back to its saved height, then a default. */
  heights?: Record<string, number>;
}

const DEFAULT_CARD_HEIGHT = 220;

/** Stacks cards down one column by their real heights, so a tall card never covers the next one. */
function stackColumn(nodes: CanvasNode[], x: number, startY: number, options: LayoutOptions): PositionDelta[] {
  let y = startY;
  return nodes.map(node => {
    const position = { id: node.id, x: Math.round(x), y: Math.round(y) };
    y += (options.heights?.[node.id] ?? node.height ?? DEFAULT_CARD_HEIGHT) + (options.rowGap ?? 40);
    return position;
  });
}

/**
 * Organizes nodes into dedicated functional columns based on epistemic record type:
 * Column 1: Sources & Links
 * Column 2: Concepts & Notes
 * Column 3: Claims & Hypotheses
 * Column 4: Questions & AI Insights
 */
export function clusterByTypeLayout(
  graph: KnowledgeGraph,
  options: LayoutOptions = {}
): PositionDelta[] {
  const startX = options.startX ?? 120;
  const startY = options.startY ?? 120;
  const colSpacing = options.columnSpacing ?? 360;

  const typeColumns: Record<string, number> = {
    source: 0,
    link: 0,
    concept: 1,
    note: 1,
    claim: 2,
    hypothesis: 2,
    question: 3,
    ai_insight: 3,
    group: 1,
    section: 1,
    task: 3,
    image: 0,
    research_result: 3
  };

  const columnBuckets: Record<number, CanvasNode[]> = {
    0: [],
    1: [],
    2: [],
    3: []
  };

  for (const node of Object.values(graph.nodesById)) {
    const colIndex = typeColumns[node.type] ?? 1;
    columnBuckets[colIndex].push(node);
  }

  const positions: PositionDelta[] = [];

  for (let col = 0; col <= 3; col++) {
    const nodesInCol = columnBuckets[col];
    // Sort alphabetically by title for deterministic, clean presentation
    nodesInCol.sort((a, b) => a.title.localeCompare(b.title));

    positions.push(...stackColumn(nodesInCol, startX + col * colSpacing, startY, options));
  }

  return positions;
}

/**
 * Topologically layered hierarchical DAG layout:
 * Follows directional edges from upstream roots (sources, antecedent concepts)
 * to downstream claims, answers, and conclusions.
 */
export function hierarchicalLayout(
  graph: KnowledgeGraph,
  options: LayoutOptions = {}
): PositionDelta[] {
  const startX = options.startX ?? 120;
  const startY = options.startY ?? 120;
  const levelSpacing = options.columnSpacing ?? 380;

  const nodes = Object.values(graph.nodesById);
  if (nodes.length === 0) return [];

  // Compute in-degrees
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const edge of Object.values(graph.edgesById)) {
    if (inDegree.has(edge.to)) {
      inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
    }
    if (adjacency.has(edge.from)) {
      adjacency.get(edge.from)?.push(edge.to);
    }
  }

  // Assign levels using BFS from root nodes (inDegree === 0)
  const nodeLevels = new Map<string, number>();
  const queue: string[] = [];

  for (const node of nodes) {
    if ((inDegree.get(node.id) || 0) === 0) {
      nodeLevels.set(node.id, 0);
      queue.push(node.id);
    }
  }

  // Handle cycle or graph without 0-degree nodes
  if (queue.length === 0 && nodes.length > 0) {
    nodeLevels.set(nodes[0].id, 0);
    queue.push(nodes[0].id);
  }

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const currentLevel = nodeLevels.get(currentId) || 0;
    const neighbors = adjacency.get(currentId) || [];

    for (const neighborId of neighbors) {
      const existingLevel = nodeLevels.get(neighborId);
      const nextLevel = currentLevel + 1;
      if (existingLevel === undefined || nextLevel > existingLevel) {
        nodeLevels.set(neighborId, nextLevel);
        queue.push(neighborId);
      }
    }
  }

  // Put any unreached disconnected components at level 0
  for (const node of nodes) {
    if (!nodeLevels.has(node.id)) {
      nodeLevels.set(node.id, 0);
    }
  }

  // Group nodes by level
  const levelGroups = new Map<number, CanvasNode[]>();
  for (const node of nodes) {
    const level = nodeLevels.get(node.id) || 0;
    if (!levelGroups.has(level)) levelGroups.set(level, []);
    levelGroups.get(level)!.push(node);
  }

  const positions: PositionDelta[] = [];
  const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b);

  for (const level of sortedLevels) {
    const group = levelGroups.get(level)!;
    group.sort((a, b) => a.title.localeCompare(b.title));

    positions.push(...stackColumn(group, startX + level * levelSpacing, startY, options));
  }

  return positions;
}

/**
 * Arranges nodes into a compact balanced grid
 */
export function compactGridLayout(
  graph: KnowledgeGraph,
  options: LayoutOptions = {}
): PositionDelta[] {
  const startX = options.startX ?? 120;
  const startY = options.startY ?? 120;
  const colSpacing = options.columnSpacing ?? 340;

  const nodes = Object.values(graph.nodesById);
  if (nodes.length === 0) return [];

  const cols = Math.max(2, Math.ceil(Math.sqrt(nodes.length * 1.5)));
  const positions: PositionDelta[] = [];

  for (let col = 0; col < cols; col++) {
    positions.push(...stackColumn(nodes.filter((_, i) => i % cols === col), startX + col * colSpacing, startY, options));
  }

  return positions;
}

/**
 * Universal layout runner for Chat Tool execution
 */
export function computeOrganizedLayout(
  graph: KnowledgeGraph,
  strategy: 'cluster_by_type' | 'hierarchical' | 'compact' = 'cluster_by_type',
  options: LayoutOptions = {}
): PositionDelta[] {
  switch (strategy) {
    case 'hierarchical':
      return hierarchicalLayout(graph, options);
    case 'compact':
      return compactGridLayout(graph, options);
    case 'cluster_by_type':
    default:
      return clusterByTypeLayout(graph, options);
  }
}
