'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PresencePeer } from '@/components/collab/useCollaboration';
import { initialsOf } from '@/components/collab/PresenceBar';
import { ExternalLink, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
import type { CanvasNode, Connection, Coordinates, SectionResizeHandle, CanvasNodeType, Viewport } from '@/types/canvas';
import type { KnowledgeGraph } from '@/lib/graph';
import { RelationshipControls } from './RelationshipControls';
import { getLinkThumbnail, extractYouTubeVideoId } from './SourceMetadata';
import { NodeCard } from './nodes';

// Relations are ink-grey; only drafts are proof blue. The keys stay so stored edge colours still resolve.
const RELATION_GREY = '#6B6F76';
const RELATION_PALETTE: Record<string, string> = {
  neutral: RELATION_GREY, indigo: RELATION_GREY, emerald: RELATION_GREY, rose: RELATION_GREY,
  amber: RELATION_GREY, sky: RELATION_GREY, purple: RELATION_GREY
};
import { FileViewerModal, ImageViewerModal } from './FileAndMediaModal';
import { Minimap } from './Minimap';
import { SketchLayer, type SketchStroke } from './SketchLayer';
import { DEFAULT_SKETCH_STYLE, clusterWidth, type SketchStyle } from './inkPalette';
import { uploadFile } from '@/lib/upload';
import { extractPageNumber, type CitationReference } from '@/utils/citation';
/** Phones get one-finger panning; tablets and desktops keep marquee selection. */
const isPhoneTouch = (event: { pointerType: string }) =>
  event.pointerType === 'touch' && typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches;
/** How far two fingers must spread or pinch (as a share of their start distance) before the map zooms. */
const PINCH_ZOOM_THRESHOLD = .1;
/** How far outside a drop zone a drag still counts as over it. */
const DROP_ZONE_SLOP = 28;

type DropZone = 'trash' | 'context';

/**
 * The drop zone under the pointer. The two zones sit side by side, so their slop overlaps: the nearer one wins,
 * and the strip between them belongs to neither (a drop meant for the chat must never delete).
 */
function dropZoneAt(x: number, y: number, trash: DOMRect | undefined, context: DOMRect | undefined): DropZone | null {
  const distance = (rect: DOMRect) => Math.hypot(
    Math.max(rect.left - x, 0, x - rect.right),
    Math.max(rect.top - y, 0, y - rect.bottom)
  );
  const near = (rect: DOMRect | undefined) => (rect && distance(rect) <= DROP_ZONE_SLOP ? rect : undefined);
  const t = near(trash);
  const c = near(context);
  if (t && c) {
    const gapLeft = Math.min(t.right, c.right);
    const gapRight = Math.max(t.left, c.left);
    if (x >= gapLeft && x <= gapRight) return null;
    const dt = distance(t), dc = distance(c);
    return dt < dc ? 'trash' : dc < dt ? 'context' : null;
  }
  return t ? 'trash' : c ? 'context' : null;
}

type Gesture =
  // On phones a one-finger touch pans; `tap` records what a touch that never moved should do instead.
  | { kind: 'pan'; start: Coordinates; origin: Coordinates; tap?: { clear: true } | { selectId: string } }
  // `zooming` stays false until the fingers clearly spread or pinch, so a two-finger pan never zooms.
  | { kind: 'pinch'; startDistance: number; startZoom: number; anchor: Coordinates; zooming: boolean }
  | { kind: 'drag'; start: Coordinates; origins: Record<string, Coordinates>; primaryId?: string; noteIds: string[] }
  | { kind: 'resize'; start: Coordinates; node: CanvasNode; handle: SectionResizeHandle }
  | { kind: 'marquee'; startClient: Coordinates; currentClient: Coordinates; additive: boolean };


const isCluster = (node: CanvasNode) => node.type === 'group' || node.type === 'section';

/** Template maps store the unprefixed cluster id ("guide-section-x") while the cluster itself is
 *  "project-…-guide-section-x"; a reference matches either. */
function refersTo(sectionId: string | undefined, group: CanvasNode) {
  return Boolean(sectionId && (sectionId === group.id || group.id.endsWith(`-${sectionId}`)));
}

/** A cluster holds exactly the notes the user dropped into it. Position alone never makes a note a member,
 *  so dragging a cluster across the board doesn't sweep up the notes it passes over. */
export function membersOf(group: CanvasNode, nodes: CanvasNode[]): CanvasNode[] {
  return nodes.filter(node => node.id !== group.id && !isCluster(node) && refersTo(node.sectionId, group));
}

/** The cluster a note belongs to, if any. */
export function clusterIdOf(node: CanvasNode, nodes: CanvasNode[]): string | null {
  if (!node.sectionId || isCluster(node)) return null;
  return nodes.find(other => isCluster(other) && refersTo(node.sectionId, other))?.id ?? null;
}

/** Maps saved before membership was explicit relied on position: a note with no (valid) cluster reference that
 *  sat inside a cluster's area belonged to it. Record that as an explicit reference once, when a map is loaded. */
export function adoptLegacyClusterMembers(nodes: CanvasNode[]): CanvasNode[] {
  if (!Array.isArray(nodes)) return nodes;
  const clusters = nodes.filter(isCluster);
  if (!clusters.length) return nodes;
  let changed = false;
  const next = nodes.map(node => {
    if (isCluster(node) || clusterIdOf(node, nodes)) return node;
    const home = clusters.find(group => {
      const width = group.width || 540;
      const height = group.height || 360;
      return node.x >= group.x && node.y >= group.y && node.x < group.x + width && node.y < group.y + height;
    });
    if (!home) return node;
    changed = true;
    return { ...node, sectionId: home.id };
  });
  return changed ? next : nodes;
}

type Box = { x: number; y: number; width: number; height: number };
const NOTE_GAP = 8; // notes keep at least this much board between them

/** Ids in `boxes` that would overlap a visible note that isn't moving. Clusters are areas, not obstacles. */
function collidingIds(boxes: Record<string, Box>, nodes: CanvasNode[], bounds: Record<string, Box>, visible: Set<string>) {
  const hits: string[] = [];
  for (const [id, box] of Object.entries(boxes)) {
    for (const other of nodes) {
      if (other.id in boxes || other.type === 'group' || other.type === 'section' || !visible.has(other.id)) continue;
      const ob = bounds[other.id];
      if (!ob) continue;
      if (box.x < ob.x + ob.width + NOTE_GAP && box.x + box.width + NOTE_GAP > ob.x && box.y < ob.y + ob.height + NOTE_GAP && box.y + box.height + NOTE_GAP > ob.y) {
        hits.push(id);
        break;
      }
    }
  }
  return hits;
}

export function groupBounds(group: CanvasNode, members: CanvasNode[]) {
  if (group.metadata?.collapsed === true) {
    // A folded cluster is a taped sheet listing every note by title, so it grows with them.
    const width = 340;
    const height = 76 + Math.max(1, members.length) * 30;
    return { x: group.x, y: group.y, width, height };
  }

  // Generous padding around all enclosed items inside cluster
  const PADDING_LEFT = 36;
  const PADDING_RIGHT = 36;
  const PADDING_TOP = 58; // comfortable clearance below cluster header bar
  const PADDING_BOTTOM = 36;

  const minBaseWidth = Math.max(380, group.width || 560);
  const minBaseHeight = Math.max(260, group.height || 380);

  if (members.length === 0) {
    return { x: group.x, y: group.y, width: minBaseWidth, height: minBaseHeight };
  }

  // Calculate the encompassing bounds of all members with padding
  const memberMinX = Math.min(...members.map(n => n.x - PADDING_LEFT));
  const memberMinY = Math.min(...members.map(n => n.y - PADDING_TOP));
  const memberMaxX = Math.max(...members.map(n => n.x + (n.width || 280) + PADDING_RIGHT));
  const memberMaxY = Math.max(...members.map(n => n.y + (n.height || estimateNodeHeight(n)) + PADDING_BOTTOM));

  const left = Math.min(group.x, memberMinX);
  const top = Math.min(group.y, memberMinY);
  const right = Math.max(group.x + minBaseWidth, memberMaxX);
  const bottom = Math.max(group.y + minBaseHeight, memberMaxY);

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

export function estimateNodeHeight(node: CanvasNode): number {
  if (node.height && node.height > 0) return node.height;
  if (node.type === 'group' || node.type === 'section') {
    return node.metadata?.collapsed ? 98 : (node.height || 360);
  }
  if (node.type === 'image') {
    let h = 230;
    if (node.caption || node.content) h += 36;
    return h;
  }
  let h = 51;
  const titleLines = Math.max(1, Math.ceil((node.title?.length || 10) / 26));
  h += titleLines * 22;

  const isSource = node.type === 'source' || node.type === 'link';
  const { thumbnailUrl } = getLinkThumbnail(node);
  if (isSource && thumbnailUrl) {
    h += 138;
  } else if (isSource && !node.fileData && (node.url || node.domain)) {
    h += 48;
  }
  if (isSource && node.fileData) {
    h += 46;
  }

  const content = node.content || node.description || node.caption || '';
  if (content) {
    const lines = Math.min(4, Math.max(1, Math.ceil(content.length / 35)));
    h += lines * 18 + 6;
  }

  if (isSource && (node.url || node.domain)) {
    h += 32;
  }
  if (node.metadata?.evidence?.length) {
    h += 24;
  }

  return Math.max(124, Math.round(h));
}


export function relationPath(
  from: CanvasNode,
  to: CanvasNode,
  style: Connection['lineStyle'] = 'curved',
  overrideFromHeight?: number,
  overrideToHeight?: number
): { path: string; mid: Coordinates } {
  const fw = from.width || 280;
  const tw = to.width || 280;
  const fh = overrideFromHeight || from.height || estimateNodeHeight(from);
  const th = overrideToHeight || to.height || estimateNodeHeight(to);

  const cxFrom = from.x + fw / 2;
  const cyFrom = from.y + fh / 2;
  const cxTo = to.x + tw / 2;
  const cyTo = to.y + th / 2;

  const dx = cxTo - cxFrom;
  const dy = cyTo - cyFrom;

  // Use aspect-weighted distance comparison for cards (wide rectangles)
  const aspectWeight = (fh + th) / (fw + tw);
  const isHorizontal = Math.abs(dx) * aspectWeight > Math.abs(dy);

  let startX: number;
  let startY: number;
  let endX: number;
  let endY: number;
  let orientation: 'horizontal' | 'vertical';

  if (!isHorizontal) {
    orientation = 'vertical';
    if (dy >= 0) {
      // Exit bottom of 'from', enter top of 'to'
      startY = from.y + fh;
      endY = to.y;
    } else {
      // Exit top of 'from', enter bottom of 'to'
      startY = from.y;
      endY = to.y + th;
    }

    const overlapMin = Math.max(from.x, to.x);
    const overlapMax = Math.min(from.x + fw, to.x + tw);
    if (overlapMax - overlapMin >= 24) {
      const dockX = (overlapMin + overlapMax) / 2;
      startX = dockX;
      endX = dockX;
    } else {
      startX = Math.min(Math.max(cxTo, from.x + 28), from.x + fw - 28);
      endX = Math.min(Math.max(cxFrom, to.x + 28), to.x + tw - 28);
    }
  } else {
    orientation = 'horizontal';
    if (dx >= 0) {
      startX = from.x + fw;
      endX = to.x;
    } else {
      startX = from.x;
      endX = to.x + tw;
    }

    const overlapMin = Math.max(from.y, to.y);
    const overlapMax = Math.min(from.y + fh, to.y + th);
    if (overlapMax - overlapMin >= 20) {
      const dockY = (overlapMin + overlapMax) / 2;
      startY = dockY;
      endY = dockY;
    } else {
      startY = Math.min(Math.max(cyTo, from.y + 20), from.y + fh - 20);
      endY = Math.min(Math.max(cyFrom, to.y + 20), to.y + th - 20);
    }
  }

  let path = '';
  const midX = (startX + endX) / 2;
  const midY = (startY + endY) / 2;

  if (style === 'straight') {
    path = `M ${startX} ${startY} L ${endX} ${endY}`;
  } else if (style === 'stepped') {
    if (orientation === 'horizontal') {
      path = `M ${startX} ${startY} L ${midX} ${startY} L ${midX} ${endY} L ${endX} ${endY}`;
    } else {
      path = `M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`;
    }
  } else {
    if (orientation === 'horizontal') {
      const bend = Math.min(Math.max(36, Math.abs(endX - startX) * 0.44), 140);
      const c1x = dx >= 0 ? startX + bend : startX - bend;
      const c2x = dx >= 0 ? endX - bend : endX + bend;
      path = `M ${startX} ${startY} C ${c1x} ${startY}, ${c2x} ${endY}, ${endX} ${endY}`;
    } else {
      const bend = Math.min(Math.max(34, Math.abs(endY - startY) * 0.44), 140);
      const c1y = dy >= 0 ? startY + bend : startY - bend;
      const c2y = dy >= 0 ? endY - bend : endY + bend;
      path = `M ${startX} ${startY} C ${startX} ${c1y}, ${endX} ${c2y}, ${endX} ${endY}`;
    }
  }

  return {
    path,
    mid: {
      x: orientation === 'horizontal' ? midX : midX + (dx >= 0 ? 8 : -8),
      y: orientation === 'horizontal' ? midY - 10 : midY
    }
  };
}

function DottedRelationship({ path, color, colorKey, arrowhead }: {
  path: string;
  color: string;
  colorKey: string;
  arrowhead: Connection['arrowhead'];
}) {
  const measureRef = useRef<SVGPathElement>(null);
  const [dots, setDots] = useState<Coordinates[]>([]);

  useLayoutEffect(() => {
    const measurePath = measureRef.current;
    if (!measurePath) return;
    const length = measurePath.getTotalLength();
    if (length < 1) { setDots([]); return; }
    if (length < 14) {
      const point = measurePath.getPointAtLength(length / 2);
      setDots([{ x: point.x, y: point.y }]);
      return;
    }
    const inset = Math.min(7, length / 2);
    const usableLength = Math.max(0, length - inset * 2);
    const intervals = Math.max(1, Math.round(usableLength / 12));
    const spacing = usableLength / intervals;
    setDots(Array.from({ length: intervals + 1 }, (_, index) => {
      const point = measurePath.getPointAtLength(inset + spacing * index);
      return { x: point.x, y: point.y };
    }));
  }, [path]);

  return <>
    <path ref={measureRef} className="relationship-measure-path" d={path} />
    {dots.map((dot, index) => <circle key={index} className="relationship-dot" cx={dot.x} cy={dot.y} r="1.8" fill={color} />)}
    {(arrowhead === 'end' || arrowhead === 'both' || arrowhead === 'start') && <path
      className="relationship-arrow-anchor"
      d={path}
      markerEnd={arrowhead === 'end' || arrowhead === 'both' ? `url(#relation-arrow-${colorKey})` : undefined}
      markerStart={arrowhead === 'both' || arrowhead === 'start' ? `url(#relation-arrow-${colorKey})` : undefined}
    />}
  </>;
}

// A hand-drawn pen outline: points walk the rectangle with a small, stable wobble (seeded by the cluster id),
// and the stroke starts a little past the corner and overshoots its end, the way a pen loop never quite closes.
function penOutline(width: number, height: number, seedText: string, pass: number) {
  let seed = pass * 7919;
  for (let i = 0; i < seedText.length; i++) seed = (seed * 31 + seedText.charCodeAt(i)) | 0;
  const rand = () => { seed = (seed * 1103515245 + 12345) | 0; return ((seed >>> 8) & 0xffff) / 0xffff - 0.5; };
  const inset = 4 + pass * 1.5;
  const w = Math.max(40, width - inset * 2), h = Math.max(40, height - inset * 2);
  const corners: Array<[number, number]> = [[inset, inset], [inset + w, inset], [inset + w, inset + h], [inset, inset + h]];
  const points: Array<[number, number]> = [];
  corners.forEach(([x0, y0], side) => {
    const [x1, y1] = corners[(side + 1) % 4];
    const length = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(2, Math.round(length / 56));
    const nx = -(y1 - y0) / length, ny = (x1 - x0) / length;
    for (let k = 0; k < steps; k++) {
      const t = k / steps, wobble = rand() * 2.6;
      points.push([x0 + (x1 - x0) * t + nx * wobble + rand() * 1.2, y0 + (y1 - y0) * t + ny * wobble + rand() * 1.2]);
    }
  });
  const start = points[0];
  const end: [number, number] = [start[0] + 14 + rand() * 6, start[1] + rand() * 3]; // overshoot past the start
  let d = `M ${start[0] - 6} ${start[1] + 2 + rand() * 2}`;
  const path = [...points, start, end];
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = path[i], [bx, by] = path[i + 1];
    d += ` Q ${ax.toFixed(1)} ${ay.toFixed(1)} ${((ax + bx) / 2).toFixed(1)} ${((ay + by) / 2).toFixed(1)}`;
  }
  return `${d} L ${end[0].toFixed(1)} ${end[1].toFixed(1)}`;
}

function GroupCard({
  node, members, relationCount, isCollapsed, selected, isGrabbed, dragTilt = 0, width, height, onEdit, onToggle, onOpen, onStartResize, isResizeLocked, dropState
}: {
  node: CanvasNode;
  members: CanvasNode[];
  relationCount: number;
  isCollapsed: boolean;
  selected: boolean;
  isGrabbed?: boolean;
  dragTilt?: number;
  width: number;
  height: number;
  onEdit?: () => void;
  onToggle: () => void;
  onOpen: () => void;
  onStartResize: (event: React.PointerEvent, handle: SectionResizeHandle) => void;
  isResizeLocked?: boolean;
  /** A note is being carried: 'available' while it could be dropped here, 'target' while it's over this cluster. */
  dropState?: 'available' | 'target';
}) {
  // Open: a pen loop drawn round its notes, titled on a strip of tape. Folded: a sheet of paper taped to the board.
  // A cluster may carry the user's colour (pen line and a tint of washi tape) and a line weight, set in Properties.
  const color = node.color?.startsWith('#') ? node.color : undefined;
  const count = `${members.length} ${members.length === 1 ? 'idea' : 'ideas'}${relationCount ? ` · ${relationCount} ${relationCount === 1 ? 'relation' : 'relations'}` : ''}`;
  return (
    <article
      className={`graph-group ${isCollapsed ? 'is-folded' : ''} ${selected ? 'is-selected' : ''} ${isGrabbed ? 'is-grabbed' : ''} ${color ? 'has-color' : ''} ${dropState ? `is-drop-${dropState}` : ''}`}
      style={{
        ...(isGrabbed ? { transform: `scale(1.012) rotate(${dragTilt * 0.35}deg)` } : {}),
        ...(color ? { ['--cluster-ink' as `--${string}`]: color } : {}),
        ['--cluster-weight' as `--${string}`]: `${clusterWidth(node.metadata?.penWidth)}px`
      }}
    >
      {!isCollapsed && (
        <svg className="group-pen" width={width} height={height} aria-hidden="true">
          <path className="group-pen-stroke" d={penOutline(width, height, node.id, 0)} />
          <path className="group-pen-stroke is-second" d={penOutline(width, height, node.id, 1)} />
        </svg>
      )}

      <div className="group-tape">
        <strong>{node.title}</strong>
        <span className="note-meta">{count}</span>
      </div>

      <div className="group-actions">
        {onEdit && (
          <button
            type="button"
            className="note-edit-button is-inline"
            aria-label={`Edit ${node.title}`}
            title="Edit (Enter)"
            onPointerDown={event => event.stopPropagation()}
            onClick={event => { event.stopPropagation(); onEdit(); }}
          >
            <Pencil size={14} strokeWidth={1.75} /><span>Edit</span>
          </button>
        )}
        <button
          className="icon-button group-open"
          aria-label="Open this cluster on its own"
          title="Open this cluster on its own"
          onPointerDown={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); onOpen(); }}
        >
          <ExternalLink size={16} strokeWidth={1.75} />
        </button>
        <button
          className="text-button group-fold"
          aria-expanded={!isCollapsed}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); onToggle(); }}
        >
          {isCollapsed ? 'Unfold' : 'Fold'}
        </button>
      </div>

      {dropState && (dropState === 'target' || members.length === 0) && (
        <p className="group-drop-hint" role="status">
          {dropState === 'target' ? `Release to add it to “${node.title}”` : 'Empty cluster: drop a note here to add it'}
        </p>
      )}

      {isCollapsed && (
        <ul className="group-folded-list" aria-label="Notes in this cluster">
          {members.map(member => <li key={member.id} title={member.title}><span>{member.title}</span></li>)}
          {members.length === 0 && <li className="note-meta">Empty. Unfold it to add notes.</li>}
        </ul>
      )}

      {!isCollapsed && !isResizeLocked && (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as SectionResizeHandle[]).map(handle => (
        <button
          key={handle}
          className={`group-resize-handle handle-${handle}`}
          aria-label={`Resize cluster ${handle}`}
          title="Resize cluster"
          onPointerDown={event => onStartResize(event, handle)}
        />
      ))}
    </article>
  );
}


export function GraphCanvas({
  graph, selectedNodeIds, viewport, setViewport, activeTool, spacePressed, linkingFromId,
  autoFitKey, editingNoteId, onSelectNode, onSelectMultipleNodes, onClearSelection, onClickAway, onCancelLinking, onMoveNodes, onConnect,
  onStartLinking, onToggleGroup, onEditNote, onUpdateNote, onUpdateRelationship, onDeleteRelationship, onResizeGroup, onOpenGroup,
  onAddRecordWithData, onDeleteNodes, onAddToContext, onAssignCluster, presence, onPointerWorld, projectId, isResizeLocked = false, draftIds, detachingIds, keptIds, sketch, sketchStyle, onSketchChange, onOpenEditor, placingIds, onPlaced
}: {
  graph: KnowledgeGraph;
  selectedNodeIds: string[];
  viewport: Viewport;
  setViewport: React.Dispatch<React.SetStateAction<Viewport>>;
  activeTool: 'select' | 'connect' | 'hand' | 'pen' | 'marker' | 'eraser';
  spacePressed: boolean;
  linkingFromId: string | null;
  autoFitKey: number;
  editingNoteId: string | null;
  onSelectNode: (id: string, additive: boolean) => void;
  onSelectMultipleNodes?: (ids: string[], additive?: boolean) => void;
  onClearSelection: () => void;
  onClickAway: () => void;
  onCancelLinking: () => void;
  onMoveNodes: (positions: Record<string, Coordinates>) => void;
  onConnect: (from: string, to: string) => void;
  onStartLinking: (id: string) => void;
  onToggleGroup: (id: string) => void;
  onEditNote: (id: string | null) => void;
  onUpdateNote: (id: string, content: string) => void;
  onUpdateRelationship: (id: string, fields: Partial<Connection>) => void;
  onDeleteRelationship: (id: string) => void;
  onResizeGroup: (id: string, fields: Partial<CanvasNode>) => void;
  onOpenGroup: (id: string) => void;
  onAddRecordWithData?: (type: CanvasNodeType, initialData?: Partial<CanvasNode>) => void;
  onDeleteNodes?: (ids: string[]) => void;
  /** Cards were dropped on "Add to chat": they snap back and join the next question's context. */
  onAddToContext?: (ids: string[]) => void;
  /** Notes were dropped into a cluster (id) or out of every cluster (null). Without it, membership never changes. */
  onAssignCluster?: (ids: string[], clusterId: string | null) => void;
  /** Teammates on this map: their cursors and the notes they have selected or are writing in. */
  presence?: PresencePeer[];
  /** Where the pointer is on the board (world coordinates), or null when it leaves. Shared as our live cursor. */
  onPointerWorld?: (point: Coordinates | null) => void;
  projectId?: string;
  isResizeLocked?: boolean;
  /** Node and edge ids that are AI drafts: rendered in proof blue, read-only until kept. */
  draftIds?: Set<string>;
  /** Node ids playing the pin-detach animation before removal. */
  detachingIds?: string[];
  keptIds?: string[];
  sketch?: SketchStroke[];
  sketchStyle?: SketchStyle;
  onOpenEditor?: (id: string) => void;
  /** New items not yet pinned: they stay unpinned until they sit on free board. */
  placingIds?: string[];
  onPlaced?: (id: string) => void;
  onSketchChange?: (update: (strokes: SketchStroke[]) => SketchStroke[]) => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const activePointers = useRef(new Map<number, Coordinates>());
  const pinchFrame = useRef<number | null>(null);
  const lastFittedKey = useRef<number | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [cursorWorld, setCursorWorld] = useState<Coordinates | null>(null);
  const [nodeHeights, setNodeHeights] = useState<Record<string, number>>({});
  const [draggedNodeIds, setDraggedNodeIds] = useState<string[]>([]);
  // Notes the user is carrying by hand (not the notes a dragged cluster brings along), and the cluster under them.
  const [carriedNoteIds, setCarriedNoteIds] = useState<string[]>([]);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const dropTargetRef = useRef<string | null>(null);
  const [dragTilt, setDragTilt] = useState<number>(0);
  const [marqueeBox, setMarqueeBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [overZone, setOverZone] = useState<DropZone | null>(null);
  const isOverTrash = overZone === 'trash';
  const isOverContext = overZone === 'context';
  const draggedCount = draggedNodeIds.length;
  const trashRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const [activeImage, setActiveImage] = useState<{ src: string; title?: string; caption?: string } | null>(null);
  const [activeFile, setActiveFile] = useState<{ fileData?: string; fileName?: string; fileSize?: number; fileType?: string; content?: string; initialPage?: number; highlightExcerpt?: string } | null>(null);

  const handleOpenEvidenceCitation = useCallback((evidence: CitationReference) => {
    const srcNode = graph.nodesById[evidence.sourceId];
    const pageNum = evidence.page || extractPageNumber(evidence.location);

    if (srcNode?.fileData) {
      setActiveFile({
        fileData: srcNode.fileData,
        fileName: srcNode.fileName || srcNode.title,
        fileSize: srcNode.fileSize,
        fileType: srcNode.fileType || 'application/pdf',
        initialPage: pageNum,
        highlightExcerpt: evidence.excerpt
      });
    } else if (srcNode) {
      onSelectNode(srcNode.id, false);
      if (srcNode.url) {
        window.open(srcNode.url, '_blank', 'noreferrer');
      }
    }
  }, [graph.nodesById, onSelectNode]);
  const lastClientX = useRef<number | null>(null);
  const rafMoveRef = useRef<number | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<Array<{ id: string; x1: number; y1: number; x2: number; y2: number; type: 'x' | 'y' }>>([]);
  const pendingMoveEvent = useRef<{ clientX: number; clientY: number; shiftKey?: boolean } | null>(null);
  const nodes = useMemo(() => Object.values(graph.nodesById), [graph]);
  const groups = useMemo(() => nodes.filter(node => node.type === 'group' || node.type === 'section'), [nodes]);
  const visibleIds = useMemo(() => new Set(nodes.filter(node => {
    if (node.type === 'group' || node.type === 'section') return true;
    return !groups.some(group => group.metadata?.collapsed === true && membersOf(group, nodes).some(member => member.id === node.id));
  }).map(node => node.id)), [nodes, groups]);

  // Pre-calculate effective bounding boxes for all visible nodes and groups
  const nodeBounds = useMemo(() => {
    const bounds: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const group of groups) {
      const mems = membersOf(group, nodes);
      bounds[group.id] = groupBounds(group, mems);
    }
    for (const node of nodes) {
      if (node.type !== 'group' && node.type !== 'section') {
        const h = node.height || nodeHeights[node.id] || estimateNodeHeight(node);
        bounds[node.id] = {
          x: node.x,
          y: node.y,
          width: node.width || (node.type === 'image' ? 320 : 280),
          height: h
        };
      }
    }
    return bounds;
  }, [nodes, groups, nodeHeights]);

  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  const blockedRef = useRef<string[]>([]);

  // A new item pins itself as soon as it sits on free board (straight away if its spawn spot was empty).
  useEffect(() => {
    if (!placingIds?.length || !onPlaced) return;
    for (const id of placingIds) {
      const box = nodeBounds[id];
      if (!box || !nodeHeights[id] || draggedNodeIds.includes(id)) continue; // wait for its real height, and for the drop
      if (!collidingIds({ [id]: box }, nodes, nodeBounds, visibleIds).length) onPlaced(id);
    }
  }, [placingIds, onPlaced, nodeBounds, nodeHeights, nodes, visibleIds, draggedNodeIds]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !onAddRecordWithData) return;

    // Drops are for things brought in from outside. A picture or link inside a card must not be dragged out of it:
    // the drop below would turn its URL into a copy of the card. Text being dragged inside an editor still moves.
    const handleDragStart = (e: DragEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) e.preventDefault();
    };

    const handleDragOver = (e: DragEvent) => {
      if (
        e.dataTransfer?.types.includes('Files') ||
        e.dataTransfer?.types.includes('text/uri-list') ||
        e.dataTransfer?.types.includes('text/plain')
      ) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };

    const handleDrop = (e: DragEvent) => {
      const uri = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
      const rect = canvas.getBoundingClientRect();
      const worldX = (e.clientX - rect.left - viewport.pan.x) / viewport.zoom;
      const worldY = (e.clientY - rect.top - viewport.pan.y) / viewport.zoom;

      if (uri && (uri.trim().startsWith('http://') || uri.trim().startsWith('https://'))) {
        e.preventDefault();
        const cleanUrl = uri.trim();
        const ytId = extractYouTubeVideoId(cleanUrl);
        onAddRecordWithData('source', {
          x: Math.round(worldX - 140),
          y: Math.round(worldY - 80),
          title: ytId ? 'YouTube video' : 'Web link',
          url: cleanUrl,
          imageUrl: ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : undefined,
          domain: ytId ? 'youtube.com' : undefined,
          metadata: {
            origin: 'user',
            siteName: ytId ? 'YouTube' : undefined,
            image: ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : undefined
          }
        });
        return;
      }

      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      const file = e.dataTransfer.files[0];

      if (file.type.startsWith('image/')) {
        uploadFile(file, projectId).then(uploaded => {
          onAddRecordWithData('image', {
            x: Math.round(worldX - 160),
            y: Math.round(worldY - 100),
            title: file.name.replace(/\.[^/.]+$/, ''),
            imageUrl: uploaded.url,
            fileData: uploaded.url,
            fileName: uploaded.fileName,
            fileSize: uploaded.fileSize,
            fileType: uploaded.fileType
          });
        });
      } else {
        const ext = file.name.split('.').pop()?.toLowerCase() || 'file';
        const isText = ['json', 'txt', 'csv', 'tsv', 'md', 'js', 'ts', 'jsx', 'tsx', 'py', 'html', 'css', 'sql', 'sh', 'yaml', 'yml'].includes(ext) || file.type.startsWith('text/') || file.type.includes('json');

        if (isText) {
          const textReader = new FileReader();
          textReader.onload = (textEv) => {
            const textContent = textEv.target?.result as string;
            uploadFile(file, projectId).then(uploaded => {
              onAddRecordWithData('source', {
                x: Math.round(worldX - 140),
                y: Math.round(worldY - 80),
                title: file.name.replace(/\.[^/.]+$/, ''),
                content: textContent.length > 50000 ? textContent.slice(0, 50000) : textContent,
                fileData: uploaded.url,
                fileName: uploaded.fileName,
                fileSize: uploaded.fileSize,
                fileType: ext
              });
            });
          };
          textReader.readAsText(file);
        } else {
          uploadFile(file, projectId).then(uploaded => {
            onAddRecordWithData('source', {
              x: Math.round(worldX - 140),
              y: Math.round(worldY - 80),
              title: file.name.replace(/\.[^/.]+$/, ''),
              fileData: uploaded.url,
              fileName: uploaded.fileName,
              fileSize: uploaded.fileSize,
              fileType: ext
            });
          });
        }
      }
    };

    const handlePaste = (e: ClipboardEvent) => {
      const activeEl = document.activeElement;
      if (activeEl?.tagName === 'INPUT' || activeEl?.tagName === 'TEXTAREA' || activeEl?.getAttribute('contenteditable')) {
        return;
      }
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.indexOf('image') !== -1) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            const cx = (window.innerWidth / 2 - viewport.pan.x) / viewport.zoom;
            const cy = (window.innerHeight / 2 - viewport.pan.y) / viewport.zoom;
            uploadFile(blob, projectId, 'pasted-figure.png').then(uploaded => {
              onAddRecordWithData('image', {
                x: Math.round(cx - 160),
                y: Math.round(cy - 100),
                title: 'Pasted figure',
                imageUrl: uploaded.url,
                fileData: uploaded.url,
                fileName: uploaded.fileName,
                fileSize: uploaded.fileSize,
                fileType: uploaded.fileType
              });
            });
            return;
          }
        }
      }
    };

    canvas.addEventListener('dragstart', handleDragStart);
    canvas.addEventListener('dragover', handleDragOver);
    canvas.addEventListener('drop', handleDrop);
    window.addEventListener('paste', handlePaste);
    return () => {
      canvas.removeEventListener('dragstart', handleDragStart);
      canvas.removeEventListener('dragover', handleDragOver);
      canvas.removeEventListener('drop', handleDrop);
      window.removeEventListener('paste', handlePaste);
    };
  }, [onAddRecordWithData, viewport, projectId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => setCanvasSize({ width: canvas.clientWidth, height: canvas.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const measureNodes = () => {
      const elements = canvas.querySelectorAll<HTMLElement>('[data-graph-node]');
      const nextHeights: Record<string, number> = {};

      elements.forEach(el => {
        const id = el.dataset.graphNode;
        if (id) {
          const h = Math.round(el.offsetHeight);
          if (h > 0) nextHeights[id] = h;
        }
      });

      setNodeHeights(prev => {
        let changed = false;
        for (const [id, h] of Object.entries(nextHeights)) {
          if (prev[id] !== h) {
            changed = true;
            break;
          }
        }
        return changed ? { ...prev, ...nextHeights } : prev;
      });
    };

    const observer = new ResizeObserver(measureNodes);
    const elements = canvas.querySelectorAll<HTMLElement>('[data-graph-node]');
    elements.forEach(el => observer.observe(el));
    measureNodes();

    return () => observer.disconnect();
  }, [nodes, editingNoteId]);

  const handleFitCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0 || canvasSize.width === 0 || canvasSize.height === 0) return;
    // On phones only the drafts fit on screen, so frame them: they are what the draft bar is asking about.
    const framed = canvasSize.width < 600 && draftIds?.size ? nodes.filter(node => draftIds.has(node.id)) : nodes;
    const bounds = framed.reduce((current, node) => ({
      left: Math.min(current.left, node.x),
      top: Math.min(current.top, node.y),
      right: Math.max(current.right, node.x + (node.width || 280)),
      bottom: Math.max(current.bottom, node.y + (node.height || nodeHeights[node.id] || estimateNodeHeight(node)))
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const width = Math.max(1, bounds.right - bounds.left);
    const height = Math.max(1, bounds.bottom - bounds.top);
    // On phones, fitting a whole map makes notes unreadable; keep a readable floor and let people pan.
    const phone = canvasSize.width < 600;
    const minZoom = phone ? .6 : .2;
    // Keep the map clear of what floats over the board: the top bar (and the draft bar under it), the
    // composer along the bottom, and the tool dock on the left. Phones reserve more for their tool row.
    const reserveTop = phone ? 250 : draftIds?.size ? 140 : 80;
    const reserveBottom = phone ? 170 : 110;
    const usableHeight = canvasSize.height - reserveTop - reserveBottom;
    const zoom = Math.max(minZoom, Math.min(.85,
      (canvasSize.width - (phone ? 56 : 180)) / width,
      (phone ? canvasSize.height - 110 : usableHeight) / height));
    setViewport({
      zoom,
      pan: {
        x: (canvasSize.width - width * zoom) / 2 - bounds.left * zoom,
        y: reserveTop + Math.max(0, (usableHeight - height * zoom) / 2) - bounds.top * zoom
      }
    });
  }, [nodes, nodeHeights, canvasSize.width, canvasSize.height, setViewport, draftIds]);

  useEffect(() => {
    if (nodes.length === 0 || canvasSize.width === 0 || canvasSize.height === 0 || lastFittedKey.current === autoFitKey) return;
    lastFittedKey.current = autoFitKey;
    handleFitCanvas();
  // The caller increments this key only when a graph should be framed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFitKey, handleFitCanvas]);

  // New cards are framed before they have been measured, so frame once more with their real heights.
  const fitRef = useRef(handleFitCanvas);
  useEffect(() => { fitRef.current = handleFitCanvas; }, [handleFitCanvas]);
  const hasNodes = nodes.length > 0;
  useEffect(() => {
    const timer = setTimeout(() => fitRef.current(), 200);
    return () => clearTimeout(timer);
  }, [autoFitKey, hasNodes]);

  // iOS Safari zooms the whole page on a pinch even with touch-action: none, fighting the map's own
  // zoom. Its non-standard gesture events are the only way to stop that.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const block = (event: Event) => event.preventDefault();
    canvas.addEventListener('gesturestart', block);
    canvas.addEventListener('gesturechange', block);
    return () => {
      canvas.removeEventListener('gesturestart', block);
      canvas.removeEventListener('gesturechange', block);
    };
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current) return;
      if (current.kind === 'pan') {
        setViewport(value => ({
          ...value,
          pan: { x: current.origin.x + event.clientX - current.start.x, y: current.origin.y + event.clientY - current.start.y }
        }));
      } else if (current.kind === 'marquee') {
        current.currentClient = { x: event.clientX, y: event.clientY };
        setMarqueeBox({
          x1: current.startClient.x,
          y1: current.startClient.y,
          x2: event.clientX,
          y2: event.clientY
        });

        const rect = canvasRef.current?.getBoundingClientRect();
        if (rect) {
          const worldX1 = (current.startClient.x - rect.left - viewport.pan.x) / viewport.zoom;
          const worldY1 = (current.startClient.y - rect.top - viewport.pan.y) / viewport.zoom;
          const worldX2 = (event.clientX - rect.left - viewport.pan.x) / viewport.zoom;
          const worldY2 = (event.clientY - rect.top - viewport.pan.y) / viewport.zoom;
          const minX = Math.min(worldX1, worldX2);
          const maxX = Math.max(worldX1, worldX2);
          const minY = Math.min(worldY1, worldY2);
          const maxY = Math.max(worldY1, worldY2);

          const intersectingIds = nodes.filter(node => {
            if (!visibleIds.has(node.id)) return false;
            const b = node.type === 'group' || node.type === 'section'
              ? groupBounds(node, membersOf(node, nodes))
              : {
                  x: node.x,
                  y: node.y,
                  width: node.width || 280,
                  height: nodeHeights[node.id] || estimateNodeHeight(node)
                };
            return !(
              b.x > maxX ||
              b.x + b.width < minX ||
              b.y > maxY ||
              b.y + b.height < minY
            );
          }).map(n => n.id);

          onSelectMultipleNodes?.(intersectingIds, current.additive);
        }
      } else if (current.kind === 'pinch') {
        activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        // Each finger reports its own move, so read both only once per frame: in between, one finger has
        // moved and the other has not, and the spread would look like a pinch in the middle of a pan.
        if (pinchFrame.current !== null) return;
        pinchFrame.current = requestAnimationFrame(() => {
          pinchFrame.current = null;
          const pinch = gesture.current;
          if (pinch?.kind !== 'pinch') return;
          const points = [...activePointers.current.values()];
          if (points.length < 2) return;
          const rect = canvasRef.current?.getBoundingClientRect();
          if (!rect) return;
          const distance = Math.max(1, Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y));
          const center = {
            x: (points[0].x + points[1].x) / 2 - rect.left,
            y: (points[0].y + points[1].y) / 2 - rect.top
          };
          // Fingers never keep exactly the same spread, so small changes only pan. Once the spread
          // clearly changes, zoom from that point on so the map does not jump by the dead zone.
          if (!pinch.zooming) {
            if (Math.abs(distance / pinch.startDistance - 1) < PINCH_ZOOM_THRESHOLD) {
              setViewport(value => ({ ...value, pan: { x: center.x - pinch.anchor.x * pinch.startZoom, y: center.y - pinch.anchor.y * pinch.startZoom } }));
              return;
            }
            pinch.zooming = true;
            pinch.startDistance = distance;
          }
          setViewport(() => {
            const zoom = Math.min(1.6, Math.max(.28, pinch.startZoom * distance / pinch.startDistance));
            return { zoom, pan: { x: center.x - pinch.anchor.x * zoom, y: center.y - pinch.anchor.y * zoom } };
          });
        });
      } else if (current.kind === 'resize') {
        const dx = (event.clientX - current.start.x) / viewport.zoom;
        const dy = (event.clientY - current.start.y) / viewport.zoom;
        const isGroup = current.node.type === 'group' || current.node.type === 'section';
        const defaultWidth = isGroup ? 540 : (current.node.type === 'image' ? 320 : 280);
        const defaultHeight = isGroup ? 360 : 130;
        const { x, y, width = defaultWidth, height = defaultHeight } = current.node;
        const handle = current.handle;
        const nextX = handle.includes('w') ? x + dx : x;
        const nextY = handle.includes('n') ? y + dy : y;
        const minW = isGroup ? 300 : 180;
        const minH = isGroup ? 220 : 100;
        const nextWidth = Math.max(minW, width + (handle.includes('e') ? dx : handle.includes('w') ? -dx : 0));
        const nextHeight = Math.max(minH, height + (handle.includes('s') ? dy : handle.includes('n') ? -dy : 0));
        if (!isGroup) {
          const hits = collidingIds({ [current.node.id]: { x: nextX, y: nextY, width: nextWidth, height: nextHeight } }, nodes, nodeBounds, visibleIds);
          if (hits.join() !== blockedRef.current.join()) { blockedRef.current = hits; setBlockedIds(hits); }
        }
        onResizeGroup(current.node.id, { x: nextX, y: nextY, width: nextWidth, height: nextHeight });
      } else {
        pendingMoveEvent.current = { clientX: event.clientX, clientY: event.clientY, shiftKey: event.shiftKey };
        if (rafMoveRef.current === null) {
          rafMoveRef.current = requestAnimationFrame(() => {
            rafMoveRef.current = null;
            const ev = pendingMoveEvent.current;
            const cur = gesture.current;
            if (!ev || !cur || cur.kind !== 'drag') return;

            const rawDx = (ev.clientX - cur.start.x) / viewport.zoom;
            const rawDy = (ev.clientY - cur.start.y) / viewport.zoom;

            let finalDx = rawDx;
            let finalDy = rawDy;
            const nextGuides: Array<{ id: string; x1: number; y1: number; x2: number; y2: number; type: 'x' | 'y' }> = [];

            // Smart Alignment Snapping (Hold Shift to disable snapping for freehand motion)
            if (!ev.shiftKey && cur.primaryId && cur.origins[cur.primaryId]) {
              const primaryOrigin = cur.origins[cur.primaryId];
              const pNode = graph.nodesById[cur.primaryId];
              if (pNode) {
                const pBox = nodeBounds[cur.primaryId] || {
                  x: primaryOrigin.x,
                  y: primaryOrigin.y,
                  width: pNode.width || 280,
                  height: nodeHeights[cur.primaryId] || estimateNodeHeight(pNode)
                };

                const currentX = primaryOrigin.x + rawDx;
                const currentY = primaryOrigin.y + rawDy;
                const currentWidth = pBox.width;
                const currentHeight = pBox.height;
                const currentCenterX = currentX + currentWidth / 2;
                const currentRightX = currentX + currentWidth;
                const currentCenterY = currentY + currentHeight / 2;
                const currentBottomY = currentY + currentHeight;

                const SNAP_DISTANCE = 7; // distance in world coordinates
                let bestXDist = SNAP_DISTANCE;
                let snapDx = 0;
                let activeXGuide: { x: number; y1: number; y2: number } | null = null;

                let bestYDist = SNAP_DISTANCE;
                let snapDy = 0;
                let activeYGuide: { y: number; x1: number; x2: number } | null = null;

                // Test alignment against all non-dragged visible nodes/clusters
                for (const other of nodes) {
                  if (cur.origins[other.id] || !visibleIds.has(other.id)) continue;
                  const ob = nodeBounds[other.id];
                  if (!ob) continue;

                  const otherCenterX = ob.x + ob.width / 2;
                  const otherRightX = ob.x + ob.width;
                  const otherCenterY = ob.y + ob.height / 2;
                  const otherBottomY = ob.y + ob.height;

                  // Vertical Alignment (X axis): Left, Center, Right
                  if (Math.abs(currentX - ob.x) < bestXDist) {
                    bestXDist = Math.abs(currentX - ob.x);
                    snapDx = ob.x - currentX;
                    activeXGuide = { x: ob.x, y1: Math.min(currentY, ob.y) - 24, y2: Math.max(currentBottomY, otherBottomY) + 24 };
                  }
                  if (Math.abs(currentCenterX - otherCenterX) < bestXDist) {
                    bestXDist = Math.abs(currentCenterX - otherCenterX);
                    snapDx = otherCenterX - currentCenterX;
                    activeXGuide = { x: otherCenterX, y1: Math.min(currentY, ob.y) - 24, y2: Math.max(currentBottomY, otherBottomY) + 24 };
                  }
                  if (Math.abs(currentRightX - otherRightX) < bestXDist) {
                    bestXDist = Math.abs(currentRightX - otherRightX);
                    snapDx = otherRightX - currentRightX;
                    activeXGuide = { x: otherRightX, y1: Math.min(currentY, ob.y) - 24, y2: Math.max(currentBottomY, otherBottomY) + 24 };
                  }
                  if (Math.abs(currentX - otherRightX) < bestXDist) {
                    bestXDist = Math.abs(currentX - otherRightX);
                    snapDx = otherRightX - currentX;
                    activeXGuide = { x: otherRightX, y1: Math.min(currentY, ob.y) - 24, y2: Math.max(currentBottomY, otherBottomY) + 24 };
                  }
                  if (Math.abs(currentRightX - ob.x) < bestXDist) {
                    bestXDist = Math.abs(currentRightX - ob.x);
                    snapDx = ob.x - currentRightX;
                    activeXGuide = { x: ob.x, y1: Math.min(currentY, ob.y) - 24, y2: Math.max(currentBottomY, otherBottomY) + 24 };
                  }

                  // Horizontal Alignment (Y axis): Top, Center, Bottom
                  if (Math.abs(currentY - ob.y) < bestYDist) {
                    bestYDist = Math.abs(currentY - ob.y);
                    snapDy = ob.y - currentY;
                    activeYGuide = { y: ob.y, x1: Math.min(currentX, ob.x) - 24, x2: Math.max(currentRightX, otherRightX) + 24 };
                  }
                  if (Math.abs(currentCenterY - otherCenterY) < bestYDist) {
                    bestYDist = Math.abs(currentCenterY - otherCenterY);
                    snapDy = otherCenterY - currentCenterY;
                    activeYGuide = { y: otherCenterY, x1: Math.min(currentX, ob.x) - 24, x2: Math.max(currentRightX, otherRightX) + 24 };
                  }
                  if (Math.abs(currentBottomY - otherBottomY) < bestYDist) {
                    bestYDist = Math.abs(currentBottomY - otherBottomY);
                    snapDy = otherBottomY - currentBottomY;
                    activeYGuide = { y: otherBottomY, x1: Math.min(currentX, ob.x) - 24, x2: Math.max(currentRightX, otherRightX) + 24 };
                  }
                  if (Math.abs(currentY - otherBottomY) < bestYDist) {
                    bestYDist = Math.abs(currentY - otherBottomY);
                    snapDy = otherBottomY - currentY;
                    activeYGuide = { y: otherBottomY, x1: Math.min(currentX, ob.x) - 24, x2: Math.max(currentRightX, otherRightX) + 24 };
                  }
                  if (Math.abs(currentBottomY - ob.y) < bestYDist) {
                    bestYDist = Math.abs(currentBottomY - ob.y);
                    snapDy = ob.y - currentBottomY;
                    activeYGuide = { y: ob.y, x1: Math.min(currentX, ob.x) - 24, x2: Math.max(currentRightX, otherRightX) + 24 };
                  }
                }

                if (activeXGuide) {
                  finalDx += snapDx;
                  nextGuides.push({
                    id: 'guide-x',
                    x1: activeXGuide.x,
                    y1: activeXGuide.y1,
                    x2: activeXGuide.x,
                    y2: activeXGuide.y2,
                    type: 'x'
                  });
                }
                if (activeYGuide) {
                  finalDy += snapDy;
                  nextGuides.push({
                    id: 'guide-y',
                    x1: activeYGuide.x1,
                    y1: activeYGuide.y,
                    x2: activeYGuide.x2,
                    y2: activeYGuide.y,
                    type: 'y'
                  });
                }
              }
            }

            setAlignmentGuides(nextGuides);

            if (lastClientX.current !== null) {
              const vx = ev.clientX - lastClientX.current;
              const targetTilt = Math.min(4, Math.max(-4, vx * 0.42));
              setDragTilt(targetTilt);
            }
            lastClientX.current = ev.clientX;

            setOverZone(dropZoneAt(
              ev.clientX, ev.clientY,
              trashRef.current?.getBoundingClientRect(),
              onAddToContext ? contextRef.current?.getBoundingClientRect() : undefined
            ));

            // Notes may not land on other notes: flag the collision now, snap back on drop.
            const movingBoxes: Record<string, Box> = {};
            for (const [id, point] of Object.entries(cur.origins)) {
              const moving = graph.nodesById[id];
              const box = nodeBounds[id];
              if (!moving || !box || moving.type === 'group' || moving.type === 'section') continue;
              movingBoxes[id] = { x: point.x + finalDx, y: point.y + finalDy, width: box.width, height: box.height };
            }
            const hits = collidingIds(movingBoxes, nodes, nodeBounds, visibleIds);
            if (hits.join() !== blockedRef.current.join()) { blockedRef.current = hits; setBlockedIds(hits); }

            // Which cluster would take the carried notes if they were dropped now: the one under the grabbed card's centre.
            if (cur.noteIds.length && onAssignCluster) {
              const primary = cur.primaryId ? movingBoxes[cur.primaryId] : undefined;
              let target: string | null = null;
              if (primary) {
                const cx = primary.x + primary.width / 2;
                const cy = primary.y + primary.height / 2;
                for (let i = groups.length - 1; i >= 0; i--) {
                  const group = groups[i];
                  if (!visibleIds.has(group.id)) continue;
                  const area = groupBounds(group, membersOf(group, nodes).filter(member => !cur.noteIds.includes(member.id)));
                  if (cx >= area.x && cx <= area.x + area.width && cy >= area.y && cy <= area.y + area.height) { target = group.id; break; }
                }
              }
              if (target !== dropTargetRef.current) { dropTargetRef.current = target; setDropTargetId(target); }
            }

            onMoveNodes(
              Object.fromEntries(
                Object.entries(cur.origins).map(([id, point]) => [id, { x: point.x + finalDx, y: point.y + finalDy }])
              )
            );
          });
        }
      }
    };
    const up = (event: PointerEvent) => {
      activePointers.current.delete(event.pointerId);
      // Lifting one finger of a pinch keeps panning with the finger still down.
      if (gesture.current?.kind === 'pinch') {
        const remaining = [...activePointers.current.values()][0];
        gesture.current = remaining ? { kind: 'pan', start: remaining, origin: viewport.pan } : null;
        return;
      }
      if (gesture.current?.kind === 'pan' && gesture.current.tap) {
        const { tap, start } = gesture.current;
        gesture.current = null;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8) {
          if ('selectId' in tap) onSelectNode(tap.selectId, false);
          else { onClearSelection(); onClickAway(); }
        }
        return;
      }
      if (rafMoveRef.current !== null) {
        cancelAnimationFrame(rafMoveRef.current);
        rafMoveRef.current = null;
      }
      pendingMoveEvent.current = null;
      lastClientX.current = null;
      setAlignmentGuides([]);

      if (gesture.current?.kind === 'marquee') {
        const cur = gesture.current;
        const dist = Math.hypot(event.clientX - cur.startClient.x, event.clientY - cur.startClient.y);
        if (dist < 5) {
          onClearSelection();
          onClickAway();
        }
        setMarqueeBox(null);
      } else if (gesture.current?.kind === 'drag') {
        const isTrashDrop = isOverTrash;
        const isContextDrop = isOverContext;
        const nodesToDelete = [...draggedNodeIds];
        const carried = gesture.current.noteIds;
        const target = dropTargetRef.current;
        setDraggedNodeIds([]);
        setCarriedNoteIds([]);
        dropTargetRef.current = null; setDropTargetId(null);
        setDragTilt(0);
        setOverZone(null);

        if (isTrashDrop && nodesToDelete.length > 0) {
          onDeleteNodes?.(nodesToDelete);
          gesture.current = null;
          blockedRef.current = []; setBlockedIds([]);
          return;
        }
        // Added to the chat: nothing moves or changes cluster, everything goes back to where it started.
        if (isContextDrop && nodesToDelete.length > 0) {
          onMoveNodes(gesture.current.origins);
          onAddToContext?.(nodesToDelete);
          gesture.current = null;
          blockedRef.current = []; setBlockedIds([]);
          return;
        }
        // Dropped on another note: everything that moved goes back to where it started.
        if (blockedRef.current.length) onMoveNodes(gesture.current.origins);
        // A phone tap on a selected note (say, the first half of a double tap to edit it) is not a drop.
        else if (carried.length && onAssignCluster && !(isPhoneTouch(event) && Math.hypot(event.clientX - gesture.current.start.x, event.clientY - gesture.current.start.y) < 8)) {
          // Dropped: into the cluster under it, or out of the one it came from.
          const changed = carried.filter(id => {
            const note = graph.nodesById[id];
            return note && clusterIdOf(note, nodes) !== target;
          });
          if (changed.length) onAssignCluster(changed, target);
        }
      } else if (gesture.current?.kind === 'resize' && blockedRef.current.length) {
        const { id, x, y, width, height } = gesture.current.node;
        onResizeGroup(id, { x, y, width, height });
      }
      if (blockedRef.current.length) { blockedRef.current = []; setBlockedIds([]); }
      gesture.current = null;
    };
    const cancel = (event: PointerEvent) => {
      activePointers.current.delete(event.pointerId);
      if (rafMoveRef.current !== null) {
        cancelAnimationFrame(rafMoveRef.current);
        rafMoveRef.current = null;
      }
      pendingMoveEvent.current = null;
      lastClientX.current = null;
      setAlignmentGuides([]);
      setDraggedNodeIds([]);
      setCarriedNoteIds([]);
      dropTargetRef.current = null; setDropTargetId(null);
      setDragTilt(0);
      setOverZone(null);
      setMarqueeBox(null);
      blockedRef.current = []; setBlockedIds([]);
      gesture.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      if (rafMoveRef.current !== null) {
        cancelAnimationFrame(rafMoveRef.current);
        rafMoveRef.current = null;
      }
      if (pinchFrame.current !== null) {
        cancelAnimationFrame(pinchFrame.current);
        pinchFrame.current = null;
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [onMoveNodes, onResizeGroup, onSelectMultipleNodes, onDeleteNodes, onAddToContext, setViewport, viewport.zoom, viewport.pan, nodes, visibleIds, nodeHeights, isOverTrash, isOverContext, draggedNodeIds, onClearSelection, onClickAway, onSelectNode, graph.nodesById, nodeBounds, groups, onAssignCluster]);

  const trackTouchPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return;
    // The first finger of a new touch starts clean, so a lost pointerup can never leave a ghost finger behind.
    if (event.isPrimary) activePointers.current.clear();
    activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.current.size !== 2) return;
    // A second finger turns whatever the first one started into a pinch: a note it was carrying goes back.
    const previous = gesture.current;
    if (previous?.kind === 'drag') {
      if (rafMoveRef.current !== null) { cancelAnimationFrame(rafMoveRef.current); rafMoveRef.current = null; }
      onMoveNodes(previous.origins);
      setDraggedNodeIds([]);
      setCarriedNoteIds([]);
      dropTargetRef.current = null; setDropTargetId(null);
      setDragTilt(0);
      setOverZone(null);
      setAlignmentGuides([]);
      if (blockedRef.current.length) { blockedRef.current = []; setBlockedIds([]); }
    }
    setMarqueeBox(null);
    const points = [...activePointers.current.values()];
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startDistance = Math.max(1, Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y));
    const center = {
      x: (points[0].x + points[1].x) / 2 - rect.left,
      y: (points[0].y + points[1].y) / 2 - rect.top
    };
    gesture.current = {
      kind: 'pinch', startDistance, startZoom: viewport.zoom, zooming: false,
      anchor: { x: (center.x - viewport.pan.x) / viewport.zoom, y: (center.y - viewport.pan.y) / viewport.zoom }
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /** Pan tool, held Space or the middle button: every press moves the board, even on a card or its handles. */
  const isPanPress = (event: React.PointerEvent) => spacePressed || activeTool === 'hand' || event.button === 1;

  /** Starts panning from a card or a handle; the board's own handler must not also see the press. */
  const startPan = (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    gesture.current = { kind: 'pan', start: { x: event.clientX, y: event.clientY }, origin: viewport.pan };
  };

  const startCanvasPointerDown = (event: React.PointerEvent) => {
    if (gesture.current?.kind === 'pinch') return;
    if ((event.target as HTMLElement).closest('button, input, textarea, a, .markdown-editor, .relationship-controls, .knowledge-card, .graph-group-position, .canvas-tool-dock')) return;
    if (event.button !== 0 && event.button !== 1) return;

    if (linkingFromId) {
      onCancelLinking();
      return;
    }

    if (isPanPress(event)) {
      // The hand tool lets go of the selection as soon as you grab empty board; a held Space or middle
      // button pans without changing it, unless it was only a click.
      const clickAway = event.button === 0 && activeTool === 'hand' && !spacePressed;
      if (clickAway) { onClearSelection(); onClickAway(); }
      gesture.current = { kind: 'pan', start: { x: event.clientX, y: event.clientY }, origin: viewport.pan, ...(event.button === 0 && !clickAway ? { tap: { clear: true as const } } : {}) };
      return;
    }

    // Phones: one finger on empty board moves the map; a plain tap still clears the selection.
    if (activeTool === 'select' && isPhoneTouch(event)) {
      gesture.current = { kind: 'pan', start: { x: event.clientX, y: event.clientY }, origin: viewport.pan, tap: { clear: true } };
      return;
    }

    if (activeTool === 'select' && event.button === 0) {
      const additive = event.ctrlKey || event.metaKey || event.shiftKey;
      gesture.current = {
        kind: 'marquee',
        startClient: { x: event.clientX, y: event.clientY },
        currentClient: { x: event.clientX, y: event.clientY },
        additive
      };
      setMarqueeBox({
        x1: event.clientX,
        y1: event.clientY,
        x2: event.clientX,
        y2: event.clientY
      });
      if (!additive) {
        onClearSelection();
      }
      onClickAway();
    }
  };

  /** Phones: a second finger on a handle stays part of the pinch, and a cluster that is not selected
   *  pans under the finger like the rest of the board instead of resizing. */
  const touchSkipsResize = (event: React.PointerEvent, node: CanvasNode) => {
    if (gesture.current?.kind === 'pinch') { event.stopPropagation(); return true; }
    if (!isPhoneTouch(event) || selectedNodeIds.includes(node.id)) return false;
    event.stopPropagation();
    gesture.current = { kind: 'pan', start: { x: event.clientX, y: event.clientY }, origin: viewport.pan, tap: { selectId: node.id } };
    return true;
  };

  const startGroupResize = (event: React.PointerEvent, node: CanvasNode, handle: SectionResizeHandle) => {
    if (isPanPress(event)) { startPan(event); return; }
    if (isResizeLocked) return;
    if (touchSkipsResize(event, node)) return;
    event.preventDefault(); event.stopPropagation();
    // Resize from what is on screen (the loop is stretched round its notes), not the stored size underneath.
    const shown = nodeBounds[node.id];
    gesture.current = { kind: 'resize', start: { x: event.clientX, y: event.clientY }, node: shown ? { ...node, ...shown } : node, handle };
  };

  const startNodeResize = (event: React.PointerEvent, node: CanvasNode, handle: SectionResizeHandle) => {
    if (isPanPress(event)) { startPan(event); return; }
    if (isResizeLocked) return;
    if (touchSkipsResize(event, node)) return;
    event.preventDefault(); event.stopPropagation();
    gesture.current = { kind: 'resize', start: { x: event.clientX, y: event.clientY }, node, handle };
  };

  const startNodeDrag = (event: React.PointerEvent, node: CanvasNode) => {
    if (gesture.current?.kind === 'pinch') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (isPanPress(event)) { startPan(event); return; }
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, input, textarea, a, .markdown-editor')) { event.stopPropagation(); return; }
    // Phones: a finger on a note that is not selected pans the map (notes cover most of a small
    // screen), and a tap selects it. Once selected, the note can be dragged. Drafts never drag.
    if (isPhoneTouch(event) && activeTool !== 'connect' && !linkingFromId && (!selectedNodeIds.includes(node.id) || draftIds?.has(node.id))) {
      event.stopPropagation();
      gesture.current = { kind: 'pan', start: { x: event.clientX, y: event.clientY }, origin: viewport.pan, tap: { selectId: node.id } };
      return;
    }
    if (draftIds?.has(node.id)) { event.stopPropagation(); onSelectNode(node.id, false); return; }
    if (activeTool === 'connect' || linkingFromId) {
      event.preventDefault();
      event.stopPropagation();
      if (linkingFromId) onConnect(linkingFromId, node.id);
      else onStartLinking(node.id);
      return;
    }
    const additive = event.ctrlKey || event.metaKey;
    onSelectNode(node.id, additive);
    const movingIds = additive && selectedNodeIds.includes(node.id) ? selectedNodeIds : [node.id];
    const grabbedCluster = node.type === 'group' || node.type === 'section';
    const moveNodes = grabbedCluster
      ? [...new Set([...movingIds, ...membersOf(node, nodes).map(member => member.id)])]
      : movingIds;
    // Only notes picked up by hand can change cluster. A cluster carries its members without re-homing them.
    const noteIds = grabbedCluster ? [] : movingIds.filter(id => graph.nodesById[id] && !isCluster(graph.nodesById[id]));
    setDraggedNodeIds(moveNodes);
    setCarriedNoteIds(noteIds);
    setDragTilt(0);
    lastClientX.current = event.clientX;
    const origins = Object.fromEntries(moveNodes.map(id => {
      const found = graph.nodesById[id];
      return [id, { x: found.x, y: found.y }];
    }));
    gesture.current = { kind: 'drag', start: { x: event.clientX, y: event.clientY }, origins, primaryId: node.id, noteIds };
    event.stopPropagation();
  };

  const zoomAtPointer = (event: React.WheelEvent) => {
    event.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
    setViewport(current => {
      const zoom = Math.min(1.6, Math.max(0.28, current.zoom * factor));
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      return { zoom, pan: { x: x - (x - current.pan.x) * (zoom / current.zoom), y: y - (y - current.pan.y) * (zoom / current.zoom) } };
    });
  };

  // Map member IDs to their parent group ID if that group is collapsed
  const collapsedMemberToGroup = new Map<string, string>();
  for (const group of groups) {
    if (group.metadata?.collapsed === true) {
      const mems = membersOf(group, nodes);
      for (const mem of mems) {
        collapsedMemberToGroup.set(mem.id, group.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Viewport Culling & Virtualization (60 FPS for 200+ Nodes)
  // -------------------------------------------------------------------------
  const viewWidth = canvasSize.width || (typeof window !== 'undefined' ? window.innerWidth : 1920);
  const viewHeight = canvasSize.height || (typeof window !== 'undefined' ? window.innerHeight : 1080);
  const safeZoom = Math.max(0.05, viewport.zoom);
  // Buffer of 600px in world coordinates guarantees cards render before entering view during smooth pan
  const buffer = Math.max(500, 750 / safeZoom);

  const visibleWorldRect = {
    left: -viewport.pan.x / safeZoom - buffer,
    top: -viewport.pan.y / safeZoom - buffer,
    right: (-viewport.pan.x + viewWidth) / safeZoom + buffer,
    bottom: (-viewport.pan.y + viewHeight) / safeZoom + buffer
  };

  const isBoxInViewport = (box?: { x: number; y: number; width: number; height: number }) => {
    if (!box) return true;
    return (
      box.x + box.width >= visibleWorldRect.left &&
      box.x <= visibleWorldRect.right &&
      box.y + box.height >= visibleWorldRect.top &&
      box.y <= visibleWorldRect.bottom
    );
  };

  // Virtualized Groups
  const renderedGroups = groups.filter(group => {
    if (selectedNodeIds.includes(group.id) || draggedNodeIds.includes(group.id)) return true;
    const mems = membersOf(group, nodes);
    if (mems.some(m => selectedNodeIds.includes(m.id) || draggedNodeIds.includes(m.id))) return true;
    return isBoxInViewport(nodeBounds[group.id]);
  });

  // Virtualized Nodes
  const renderedVisibleNodes = nodes.filter(node => {
    if (node.type === 'group' || node.type === 'section') return false;
    if (!visibleIds.has(node.id)) return false;

    // Active, selected, dragged, or editing nodes are always kept mounted
    if (
      selectedNodeIds.includes(node.id) ||
      draggedNodeIds.includes(node.id) ||
      linkingFromId === node.id ||
      editingNoteId === node.id
    ) {
      return true;
    }

    return isBoxInViewport(nodeBounds[node.id]);
  });

  const edges: Array<{ edge: Connection; path: string; mid: Coordinates }> = [];
  for (const edge of Object.values(graph.edgesById)) {
    const effectiveFromId = collapsedMemberToGroup.get(edge.from) || edge.from;
    const effectiveToId = collapsedMemberToGroup.get(edge.to) || edge.to;

    // Skip internal edges if both nodes are collapsed into the same cluster
    if (effectiveFromId === effectiveToId) continue;

    // Both endpoints must be visible (or rerouted to a visible collapsed cluster)
    if (!visibleIds.has(effectiveFromId) || !visibleIds.has(effectiveToId)) continue;

    const fromBox = nodeBounds[effectiveFromId];
    const toBox = nodeBounds[effectiveToId];
    if (!fromBox || !toBox) continue;

    const fromNode = graph.nodesById[effectiveFromId];
    const toNode = graph.nodesById[effectiveToId];
    if (!fromNode || !toNode) continue;

    // Virtualization: Skip off-screen edge path calculation if neither endpoint is active
    const isEndpointActive = (
      selectedNodeIds.includes(effectiveFromId) ||
      selectedNodeIds.includes(effectiveToId) ||
      draggedNodeIds.includes(effectiveFromId) ||
      draggedNodeIds.includes(effectiveToId) ||
      linkingFromId === effectiveFromId ||
      linkingFromId === effectiveToId
    );

    if (!isEndpointActive) {
      const edgeMinX = Math.min(fromBox.x, toBox.x);
      const edgeMaxX = Math.max(fromBox.x + fromBox.width, toBox.x + toBox.width);
      const edgeMinY = Math.min(fromBox.y, toBox.y);
      const edgeMaxY = Math.max(fromBox.y + fromBox.height, toBox.y + toBox.height);

      const isEdgeInView = (
        edgeMaxX >= visibleWorldRect.left &&
        edgeMinX <= visibleWorldRect.right &&
        edgeMaxY >= visibleWorldRect.top &&
        edgeMinY <= visibleWorldRect.bottom
      );

      if (!isEdgeInView) continue;
    }

    const virtualFrom: CanvasNode = { ...fromNode, ...fromBox };
    const virtualTo: CanvasNode = { ...toNode, ...toBox };

    const calculated = relationPath(virtualFrom, virtualTo, edge.lineStyle, fromBox.height, toBox.height);
    edges.push({ edge, ...calculated });
  }

  const screenMarquee = marqueeBox ? {
    left: Math.min(marqueeBox.x1, marqueeBox.x2),
    top: Math.min(marqueeBox.y1, marqueeBox.y2),
    width: Math.abs(marqueeBox.x2 - marqueeBox.x1),
    height: Math.abs(marqueeBox.y2 - marqueeBox.y1)
  } : null;

  return (
    <div
      className={`graph-canvas ${spacePressed || activeTool === 'hand' ? 'is-hand-tool' : ''} ${activeTool === 'connect' ? 'is-link-tool' : ''} ${isResizeLocked ? 'canvas-resize-locked' : ''}`}
      ref={canvasRef}
      onPointerDownCapture={trackTouchPointer}
      onWheel={zoomAtPointer}
      onPointerDown={startCanvasPointerDown}
      onPointerMove={event => {
        if (!linkingFromId && !onPointerWorld) return;
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const point = { x: (event.clientX - rect.left - viewport.pan.x) / viewport.zoom, y: (event.clientY - rect.top - viewport.pan.y) / viewport.zoom };
        onPointerWorld?.(point);
        if (linkingFromId) setCursorWorld(point);
      }}
      onPointerLeave={() => onPointerWorld?.(null)}
      style={{
        // Squared notebook paper: 32px squares (10 per 320px module), panned and zoomed with the map.
        backgroundSize: `${32 * viewport.zoom}px ${32 * viewport.zoom}px`,
        backgroundPosition: `${viewport.pan.x}px ${viewport.pan.y}px`
      }}
    >

      {screenMarquee && screenMarquee.width > 2 && screenMarquee.height > 2 && (
        <div
          className="canvas-marquee-box"
          style={{
            left: screenMarquee.left,
            top: screenMarquee.top,
            width: screenMarquee.width,
            height: screenMarquee.height
          }}
        />
      )}

      <div className="graph-world" style={{ transform: `translate(${viewport.pan.x}px, ${viewport.pan.y}px) scale(${viewport.zoom})` }}>
        <svg className="relationship-layer" width="100000" height="100000">
          <defs>
            {(['neutral', 'draft'] as const).map(color => (
              <marker
                key={color}
                id={`relation-arrow-${color}`}
                markerWidth="8"
                markerHeight="8"
                refX="5.5"
                refY="3"
                orient="auto-start-reverse"
                markerUnits="strokeWidth"
              >
                <path d="M0,0 L0,6 L7,3 z" fill={color === 'draft' ? '#1F3DFF' : RELATION_GREY} />
              </marker>
            ))}
            <marker id="relation-preview-arrow" markerWidth="8" markerHeight="8" refX="5.5" refY="3" orient="auto">
              <path d="M0,0 L0,6 L7,3 z" fill="#1F3DFF" />
            </marker>
          </defs>
          {edges.map(({ edge, path }) => {
            const isDotted = edge.strokePattern === 'dotted';
            const isDashed = edge.strokePattern === 'dashed';
            const isDraft = Boolean(draftIds?.has(edge.id));
            const strokeColor = isDraft ? '#1F3DFF' : RELATION_PALETTE[edge.color || 'neutral'] || RELATION_GREY;
            const arrowKey = isDraft ? 'draft' : 'neutral';

            return (
              <g key={edge.id} className="relationship-mark">
                <path className="relationship-hit" d={path} />

                {isDotted ? <DottedRelationship
                  path={path}
                  color={strokeColor}
                  colorKey={arrowKey}
                  arrowhead={edge.arrowhead || 'end'}
                /> : <path
                  className="relationship-stroke"
                  d={path}
                  stroke={strokeColor}
                  strokeDasharray={isDashed ? '8 8' : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  markerEnd={edge.arrowhead === 'none' || edge.arrowhead === 'start' ? undefined : `url(#relation-arrow-${arrowKey})`}
                  markerStart={edge.arrowhead === 'both' || edge.arrowhead === 'start' ? `url(#relation-arrow-${arrowKey})` : undefined}
                />}

              </g>
            );
          })}
          {linkingFromId && cursorWorld && graph.nodesById[linkingFromId] && (() => {
            const from = graph.nodesById[linkingFromId];
            const fromBox = nodeBounds[from.id] || {
              x: from.x,
              y: from.y,
              width: from.width || 280,
              height: nodeHeights[from.id] || estimateNodeHeight(from)
            };
            const sx = fromBox.x + fromBox.width / 2;
            const sy = cursorWorld.y >= fromBox.y + fromBox.height / 2 ? fromBox.y + fromBox.height : fromBox.y;
            return <path className="relationship-preview" d={`M ${sx} ${sy} Q ${(sx + cursorWorld.x) / 2} ${(sy + cursorWorld.y) / 2 - 24} ${cursorWorld.x} ${cursorWorld.y}`} markerEnd="url(#relation-preview-arrow)" strokeLinecap="round" strokeLinejoin="round" />;
          })()}
          {/* Smart Alignment Guides (Snap to adjacent records) */}
          {alignmentGuides.map(guide => (
            <g key={guide.id} className="canvas-alignment-guide">
              <line
                x1={guide.x1}
                y1={guide.y1}
                x2={guide.x2}
                y2={guide.y2}
                stroke="#1F3DFF"
                strokeWidth="1.2"
                strokeDasharray="4 3"
              />
              <circle cx={guide.x1} cy={guide.y1} r="2.5" fill="#1F3DFF" />
              <circle cx={guide.x2} cy={guide.y2} r="2.5" fill="#1F3DFF" />
            </g>
          ))}
        </svg>
        {renderedGroups.map(group => {
          // A note carried away from its cluster stops stretching the loop, so leaving reads as leaving.
          const carrying = carriedNoteIds.length > 0 && Boolean(onAssignCluster);
          const allMembers = membersOf(group, nodes);
          const members = carrying && dropTargetId !== group.id ? allMembers.filter(member => !carriedNoteIds.includes(member.id)) : allMembers;
          const bounds = groupBounds(group, members);
          const relationshipCount = Object.values(graph.edgesById).filter(edge => members.some(member => member.id === edge.from || member.id === edge.to)).length;
          return (
            <div
              key={group.id}
              data-graph-node={group.id}
              className={`graph-group-position ${group.metadata?.collapsed ? 'is-folded-position' : ''}`}
              style={{ transform: `translate3d(${bounds.x}px, ${bounds.y}px, 0)`, width: bounds.width, height: bounds.height }}
              onPointerDown={event => startNodeDrag(event, group)}
              onClick={event => { event.stopPropagation(); if (spacePressed || activeTool === 'hand') return; onEditNote(null); onSelectNode(group.id, event.ctrlKey || event.metaKey); }}
              onDoubleClick={event => { event.stopPropagation(); onOpenGroup(group.id); }}
            >
              <GroupCard
                node={group}
                members={members}
                relationCount={relationshipCount}
                isCollapsed={group.metadata?.collapsed === true}
                selected={selectedNodeIds.includes(group.id)}
                isGrabbed={draggedNodeIds.includes(group.id)}
                dragTilt={draggedNodeIds.includes(group.id) ? dragTilt : 0}
                onEdit={onOpenEditor && selectedNodeIds.length === 1 && selectedNodeIds[0] === group.id ? () => onOpenEditor(group.id) : undefined}
                width={bounds.width}
                height={bounds.height}
                onToggle={() => onToggleGroup(group.id)}
                onOpen={() => onOpenGroup(group.id)}
                onStartResize={(event, handle) => startGroupResize(event, group, handle)}
                isResizeLocked={isResizeLocked}
                dropState={carrying ? (dropTargetId === group.id ? 'target' : 'available') : undefined}
              />
            </div>
          );
        })}
        {renderedVisibleNodes.map(node => (
          <NodeCard
            key={node.id}
            node={node}
            selected={selectedNodeIds.includes(node.id)}
            isGrabbed={draggedNodeIds.includes(node.id)}
            dragTilt={draggedNodeIds.includes(node.id) ? dragTilt : 0}
            isEditing={editingNoteId === node.id}
            isDraft={draftIds?.has(node.id)}
            isDetaching={detachingIds?.includes(node.id)}
            isKept={keptIds?.includes(node.id)}
            isBlocked={blockedIds.includes(node.id)}
            isPlacing={placingIds?.includes(node.id)}
            onOpenEditor={onOpenEditor && selectedNodeIds.length === 1 && selectedNodeIds[0] === node.id && !draftIds?.has(node.id) && !placingIds?.includes(node.id) ? () => onOpenEditor(node.id) : undefined}
            allNodesById={graph.nodesById}
            onOpenEvidenceCitation={handleOpenEvidenceCitation}
            onToggleEdit={() => onEditNote(editingNoteId === node.id ? null : node.id)}
            onUpdateContent={content => onUpdateNote(node.id, content)}
            onOpenLightbox={(src, title, caption) => setActiveImage({ src, title, caption })}
            onOpenFileModal={file => setActiveFile(file)}
            onPointerDown={startNodeDrag}
            onClick={(event, current) => {
              event.stopPropagation();
              if (spacePressed || activeTool === 'hand') return;
              onSelectNode(current.id, event.ctrlKey || event.metaKey);
              if (current.type !== 'note' || editingNoteId !== current.id) onEditNote(null);
            }}
            isResizeLocked={isResizeLocked}
            onStartResize={(event, handle) => startNodeResize(event, node, handle)}
          />
        ))}
        <svg className="relationship-layer relationship-label-layer" width="100000" height="100000">
          {edges.map(({ edge, mid }) => (
            <g key={edge.id} className="relationship-mark">
              <RelationshipControls connection={edge} x={mid.x} y={mid.y} onUpdate={fields => onUpdateRelationship(edge.id, fields)} onDelete={() => onDeleteRelationship(edge.id)} />
            </g>
          ))}
        </svg>

        {/* Teammates: an outline in their colour round what they've selected, a tag on what they're writing in, and their pen. */}
        {presence && presence.length > 0 && (
          <div className="presence-layer" aria-hidden="true" style={{ ['--inv-zoom' as string]: 1 / Math.max(0.05, viewport.zoom) }}>
            {presence.flatMap(peer => {
              const ids = new Set([...peer.selection, ...(peer.editing ? [peer.editing] : [])]);
              return [...ids].map(id => {
                const box = nodeBounds[id];
                if (!box || !visibleIds.has(id)) return null;
                const editing = peer.editing === id;
                return (
                  <div
                    key={`${peer.clientId}-${id}`}
                    className={`presence-outline ${editing ? 'is-editing' : ''}`}
                    style={{ left: box.x - 6, top: box.y - 6, width: box.width + 12, height: box.height + 12, ['--peer' as string]: peer.user.color }}
                  >
                    <span className="presence-tag">{editing ? `${peer.user.name} is writing…` : peer.user.name}</span>
                  </div>
                );
              });
            })}
            {presence.map(peer => peer.cursor && (
              <div key={peer.clientId} className="presence-cursor" style={{ transform: `translate(${peer.cursor.x}px, ${peer.cursor.y}px)`, ['--peer' as string]: peer.user.color }}>
                <div className="presence-cursor-inner">
                  <svg width="20" height="22" viewBox="0 0 20 22"><path d="M2 2 L17 11 L10 12.5 L6.5 19.5 Z" /></svg>
                  <span className="presence-cursor-name"><b>{initialsOf(peer.user.name)}</b>{peer.user.name}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {sketch && onSketchChange && <SketchLayer tool={activeTool} viewport={viewport} strokes={sketch} style={sketchStyle || DEFAULT_SKETCH_STYLE} onChange={onSketchChange} />}
      {linkingFromId && <div className="canvas-instruction" role="status"><span>Now click the idea to connect it to</span><button type="button" className="text-button" onClick={onCancelLinking}>Cancel</button></div>}
      {activeTool === 'connect' && !linkingFromId && <div className="canvas-instruction" role="status"><span>Click one idea, then another, to connect them</span></div>}

      {/* Drop zones: add the dragged cards to the chat, or remove them. Phones show the short labels. */}
      <div className="canvas-drop-zones">
        {onAddToContext && (
          <div
            ref={contextRef}
            className={`canvas-drop-zone canvas-context-zone ${draggedNodeIds.length > 0 ? 'is-visible' : ''} ${isOverContext ? 'is-active' : ''}`}
            role="region"
            aria-label="Drop here to add to the chat"
          >
            <MessageSquarePlus size={18} strokeWidth={1.75} />
            <span className="drop-zone-label">
              <span className="drop-zone-full">{isOverContext ? `Release to add${draggedCount > 1 ? ` ${draggedCount} ideas` : ''}` : 'Add to chat'}</span>
              <span className="drop-zone-short">{isOverContext && draggedCount > 1 ? `Add ${draggedCount}` : 'Add to chat'}</span>
            </span>
          </div>
        )}
        <div
          ref={trashRef}
          className={`canvas-drop-zone canvas-trash-zone ${draggedNodeIds.length > 0 ? 'is-visible' : ''} ${isOverTrash ? 'is-active' : ''}`}
          role="region"
          aria-label="Drop here to remove from the map"
        >
          <Trash2 size={18} strokeWidth={1.75} />
          <span className="drop-zone-label">
            <span className="drop-zone-full">{isOverTrash ? `Release to remove${draggedCount > 1 ? ` ${draggedCount} ideas` : ''} · Ctrl+Z undoes it` : 'Drop to remove'}</span>
            <span className="drop-zone-short">{isOverTrash && draggedCount > 1 ? `Remove ${draggedCount}` : 'Remove'}</span>
          </span>
        </div>
      </div>

      {/* Interactive Bird's-Eye Minimap Navigation */}
      {nodes.length > 0 && (
        <Minimap
          nodes={nodes}
          groups={groups}
          viewport={viewport}
          canvasSize={canvasSize}
          nodeBounds={nodeBounds}
          onPanTo={pan => setViewport(prev => ({ ...prev, pan }))}
          onFitCanvas={handleFitCanvas}
          selectedNodeIds={selectedNodeIds}
          draftIds={draftIds}
        />
      )}

      {screenMarquee && (
        <div
          className="canvas-marquee-box"
          style={{
            left: `${screenMarquee.left}px`,
            top: `${screenMarquee.top}px`,
            width: `${screenMarquee.width}px`,
            height: `${screenMarquee.height}px`
          }}
        />
      )}

      {activeImage && (
        <ImageViewerModal
          src={activeImage.src}
          title={activeImage.title}
          caption={activeImage.caption}
          onClose={() => setActiveImage(null)}
        />
      )}

      {activeFile && (
        <FileViewerModal
          fileData={activeFile.fileData}
          fileName={activeFile.fileName}
          fileSize={activeFile.fileSize}
          fileType={activeFile.fileType}
          content={activeFile.content}
          initialPage={activeFile.initialPage}
          highlightExcerpt={activeFile.highlightExcerpt}
          onClose={() => setActiveFile(null)}
        />
      )}
    </div>
  );
}
