export type CanvasNodeType =
  | 'concept'
  | 'note'
  | 'source'
  | 'claim'
  | 'question'
  | 'hypothesis'
  | 'image'
  | 'link'
  | 'group'
  | 'research_result'
  | 'task'
  | 'ai_insight'
  | 'section';

export type CanvasTool = 'select' | 'hand' | 'connect' | 'note' | 'task' | 'image' | 'link' | 'section';

export type SectionResizeHandle = 'se' | 's' | 'e' | 'sw' | 'ne' | 'nw' | 'w' | 'n';

export type AccentColor = 'neutral' | 'terracotta' | 'sage' | 'cobalt' | 'lavender' | 'rose' | string;

export function hexToRgba(hex?: string, alpha: number = 1): string {
  if (!hex || !hex.startsWith('#')) return `rgba(60, 110, 113, ${alpha})`;
  const cleanHex = hex.replace('#', '');
  if (cleanHex.length === 6) {
    const r = parseInt(cleanHex.slice(0, 2), 16);
    const g = parseInt(cleanHex.slice(2, 4), 16);
    const b = parseInt(cleanHex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return hex;
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface TaskItem {
  id: string;
  text: string;
  completed: boolean;
}

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  color?: AccentColor;
  title: string;
  content?: string;
  items?: TaskItem[];
  imageUrl?: string;
  caption?: string;
  url?: string;
  domain?: string;
  description?: string;
  sectionId?: string;
  fileData?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  pageCount?: number;
  metadata?: {
    origin?: 'user' | 'imported' | 'ai' | 'inferred' | 'example';
    claimStatus?: 'supported' | 'weakly_supported' | 'disputed' | 'contradicted' | 'unverified' | 'open_question' | 'outdated';
    confidence?: number;
    sourceIds?: string[];
    evidence?: Array<{
      sourceId: string;
      excerpt?: string;
      location?: string;
      page?: number;
      relation: 'supports' | 'contradicts';
    }>;
    rationale?: string;
    [key: string]: unknown;
  };
  createdAt: number;
}

export type ArrowheadType = 'end' | 'both' | 'start' | 'none';
export type ConnectionLineStyle = 'curved' | 'straight' | 'stepped';
export type ConnectionStrokePattern = 'solid' | 'dashed' | 'dotted';
export type ConnectionColor = 'indigo' | 'emerald' | 'rose' | 'amber' | 'sky' | 'purple' | 'neutral';

export interface OntologyPreset {
  id: string;
  label: string;
  displayName: string;
  color: ConnectionColor;
  strokePattern: ConnectionStrokePattern;
  lineStyle: ConnectionLineStyle;
  arrowhead: ArrowheadType;
  description: string;
  hex: string;
}

export const ONTOLOGY_PRESETS: OntologyPreset[] = [
  {
    id: 'supports',
    label: 'supports',
    displayName: 'Supports',
    color: 'emerald',
    strokePattern: 'solid',
    lineStyle: 'curved',
    arrowhead: 'end',
    description: 'Evidentiary backing or validation',
    hex: '#6B6F76'
  },
  {
    id: 'contradicts',
    label: 'contradicts',
    displayName: 'Contradicts',
    color: 'rose',
    strokePattern: 'dashed',
    lineStyle: 'curved',
    arrowhead: 'end',
    description: 'Conflicting assertion or counterargument',
    hex: '#6B6F76'
  },
  {
    id: 'depends_on',
    label: 'depends_on',
    displayName: 'Depends on',
    color: 'amber',
    strokePattern: 'solid',
    lineStyle: 'stepped',
    arrowhead: 'end',
    description: 'Prerequisite requirement or dependency',
    hex: '#6B6F76'
  },
  {
    id: 'derived_from',
    label: 'derived_from',
    displayName: 'Derived from',
    color: 'indigo',
    strokePattern: 'solid',
    lineStyle: 'curved',
    arrowhead: 'end',
    description: 'Lineage, origin, or inference',
    hex: '#6B6F76'
  },
  {
    id: 'answers',
    label: 'answers',
    displayName: 'Answers',
    color: 'sky',
    strokePattern: 'dotted',
    lineStyle: 'straight',
    arrowhead: 'end',
    description: 'Resolves question or research inquiry',
    hex: '#6B6F76'
  }
];

export interface Connection {
  id: string;
  from: string;
  to: string;
  label?: string;
  arrowhead?: ArrowheadType;
  lineStyle?: ConnectionLineStyle;
  strokePattern?: ConnectionStrokePattern;
  color?: ConnectionColor;
  animated?: boolean;
  metadata?: {
    confidence?: number;
    evidence?: string;
    sourceId?: string;
    [key: string]: unknown;
  };
}

export type CanvasConnection = Connection;

export interface ConnectionPath extends Connection {
  path: string;
  mid: { x: number; y: number };
}

export type ThemeMode = 'light' | 'dark';

export interface ThemeTokens {
  canvasBg: string;
  dotColor: string;
  cardBase: string;
  cardBorder: string;
  cardBorderHover: string;
  cardSelected: string;
  headerText: string;
  bodyText: string;
  subText: string;
  panelBg: string;
  toolHover: string;
  tagBg: string;
  connectorStroke: string;
  connectorActive: string;
}

export interface AccentSwatch {
  name: string;
  badge: string;
  lightBorder: string;
  darkBorder: string;
  lightHeader: string;
  darkHeader: string;
}

export interface LedgerState {
  monthlyBudgetUsd: number;
  spentUsd: number;
  costPerRun: number;
}

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface ToastMessage {
  id: number;
  msg: string;
  type: ToastType;
}

export type AiActionType = 'summarize' | 'expand' | 'generate-tasks' | 'critique';

export interface Coordinates {
  x: number;
  y: number;
}

export interface Viewport {
  zoom: number;
  pan: Coordinates;
}

export interface ResearchBlueprint {
  topicSummary: string;
  nodes: Array<{
    tempId: string;
    type: CanvasNodeType;
    title: string;
    content?: string;
    color?: AccentColor;
    col: number;
    row: number;
    taskItems?: string[];
    linkUrl?: string;
    linkDomain?: string;
  }>;
  connections: Array<{
    fromTempId: string;
    toTempId: string;
    label: string;
  }>;
}

/**
 * quick/deep: web research on a question. organize: sorts the user's own raw thinking into a map,
 * no search. check: organize, then search whether the specifics are outdated or have better alternatives.
 */
export type ResearchMode = 'quick' | 'deep' | 'organize' | 'check';
/** A review session's origin: one of the research modes, or additions proposed by an AI app over MCP. */
export type SessionMode = ResearchMode | 'mcp';

export const RESEARCH_MODE_LABELS: Record<SessionMode, string> = {
  quick: 'Quick research',
  deep: 'Deep research',
  organize: 'Organized thinking',
  check: 'Plan check',
  mcp: 'From an AI app'
};

/** Longest input each mode accepts: research takes a question, organize and check take a dump of notes. */
export const RESEARCH_INPUT_LIMITS: Record<ResearchMode, number> = {
  quick: 500,
  deep: 500,
  organize: 6000,
  check: 6000
};
export type ResearchChangeStatus = 'pending' | 'accepted' | 'rejected';

export interface ResearchChange {
  id: string;
  kind: 'node' | 'relationship';
  payload: CanvasNode | Connection;
  status: ResearchChangeStatus;
  rationale?: string;
}

export interface ResearchSession {
  id: string;
  query: string;
  mode: SessionMode;
  status: 'review' | 'complete';
  summary: string;
  trail: string[];
  changes: ResearchChange[];
  createdAt: number;
}

export interface GraphRevisionSummary {
  id: string;
  projectId: string;
  title: string;
  nodeCount: number;
  edgeCount: number;
  createdAt: number;
}

export interface GraphRevision extends GraphRevisionSummary {
  nodes: CanvasNode[];
  relationships: Connection[];
}

export interface DatabaseSnapshotSummary {
  id: string;
  fileName: string;
  label: string;
  sizeBytes: number;
  projectCount: number;
  nodeCount: number;
  edgeCount: number;
  createdAt: number;
}
