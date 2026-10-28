'use client';

import { X } from 'lucide-react';
import { MarkdownView } from '@/components/research/MarkdownView';
import { nodeLabel } from '@/components/research/nodes/BaseKnowledgeCard';
import type { GraphConflict } from '@/lib/sync/merge';
import type { ResolutionChoice } from '@/lib/sync/resolve';
import type { CanvasNode, Connection } from '@/types/canvas';

// Shows merge conflicts one by one, "Your version" beside "Cloud version". Presentational: the caller applies each answer.

type Side = CanvasNode | Connection | string | undefined;

const BUTTONS: Record<string, [ResolutionChoice, string][]> = {
  'both-changed': [['mine', 'Keep mine'], ['cloud', 'Keep cloud'], ['both', 'Keep both']],
  deleted: [['keep', 'Keep it'], ['delete', 'Delete it']],
  title: [['mine', 'Keep mine'], ['cloud', 'Keep cloud']],
  edge: [['mine', 'Keep mine'], ['cloud', 'Keep cloud']],
};

function buttonsFor(conflict: GraphConflict) {
  if (conflict.kind === 'title') return BUTTONS.title;
  if (conflict.reason !== 'both-changed') return BUTTONS.deleted;
  return conflict.kind === 'edge' ? BUTTONS.edge : BUTTONS['both-changed']; // a link has no copy to keep both
}

function headingFor(conflict: GraphConflict) {
  if (conflict.kind === 'project') {
    return conflict.reason === 'deleted-remote' ? 'This map was deleted in the cloud' : 'You deleted this map, but it changed in the cloud';
  }
  const what = conflict.kind === 'title' ? 'The map title' : conflict.kind === 'edge' ? 'A link' : 'A note';
  if (conflict.reason === 'deleted-local') return `You deleted ${what.toLowerCase()}, but it changed in the cloud`;
  if (conflict.reason === 'deleted-remote') return `${what} was deleted in the cloud, but you changed it`;
  return `${what} changed here and in the cloud`;
}

const isNode = (value: Side): value is CanvasNode => typeof value === 'object' && 'type' in value;

export function ConflictPanel({ conflicts, onResolve, onClose, graph }: {
  conflicts: GraphConflict[];
  onResolve: (conflictId: string, choice: ResolutionChoice) => void;
  onClose: () => void;
  /** The current map, to name link endpoints and list a note's links. */
  graph?: { nodes: CanvasNode[]; relationships: Connection[] };
}) {
  const n = conflicts.length;
  const titleOf = (id: string) => graph?.nodes.find(node => node.id === id)?.title
    ?? conflicts.map(c => c.local ?? c.remote).find((side): side is CanvasNode => isNode(side) && side.id === id)?.title
    ?? 'a deleted note';
  // "Keep mine" keeps the item as it is now (edits go on while conflicts wait), so show that one.
  const currentOf = (conflict: GraphConflict): Side => (conflict.kind === 'node'
    ? graph?.nodes.find(node => node.id === conflict.itemId)
    : conflict.kind === 'edge' ? graph?.relationships.find(edge => edge.id === conflict.itemId) : undefined) ?? conflict.local;
  const linkText = (edge: Connection) => `${titleOf(edge.from)} ${(edge.label || 'relates to').replaceAll('_', ' ')} ${titleOf(edge.to)}`;

  const renderSide = (conflict: GraphConflict, side: Side, label: string) => {
    let body;
    if (side === undefined) body = <p className="note-meta">Deleted</p>;
    else if (typeof side === 'string') body = <strong>{side}</strong>;
    else if (isNode(side)) {
      const links = [...(graph?.relationships ?? []), ...(conflict.edges ?? [])]
        .filter((edge, index, all) => (edge.from === side.id || edge.to === side.id) && all.findIndex(e => e.id === edge.id) === index);
      const status = side.metadata?.claimStatus?.replaceAll('_', ' ');
      body = <>
        <strong>{side.title}</strong>
        <span className="note-meta">{[nodeLabel[side.type] || 'Idea', status].filter(Boolean).join(' · ')}</span>
        {side.content ? <MarkdownView content={side.content} className="conflict-content" /> : null}
        {links.length > 0 && <ul className="conflict-links" aria-label="Links in and out">{links.map(edge => <li key={edge.id}>{linkText(edge)}</li>)}</ul>}
      </>;
    } else body = <strong>{linkText(side)}</strong>;
    return <section className="conflict-side" aria-label={label}><h4>{label}</h4>{body}</section>;
  };

  return <div className="modal-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="work-modal review-modal conflict-panel" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <div className="review-head">
        <div>
          <h2 id="conflict-title">{`${n} conflict${n === 1 ? '' : 's'} need your decision`}</h2>
          <p className="note-meta">Saving is paused until each one is decided.</p>
        </div>
        <button className="icon-button" aria-label="Close conflicts" onClick={onClose}><X size={18} strokeWidth={1.75} /></button>
      </div>
      <div className="review-changes">
        {conflicts.map(conflict => {
          const heading = headingFor(conflict);
          return <article key={conflict.id} className="review-change conflict-item">
            <h3>{heading}</h3>
            {conflict.kind !== 'project' && <div className="conflict-sides">
              {renderSide(conflict, currentOf(conflict), 'Your version')}
              {renderSide(conflict, conflict.remote, 'Cloud version')}
            </div>}
            <div className="conflict-actions" role="group" aria-label={heading}>
              {buttonsFor(conflict).map(([choice, text], index) => (
                <button key={choice} type="button" className={index === 0 ? 'ink-button' : 'line-button'} onClick={() => onResolve(conflict.id, choice)}>{text}</button>
              ))}
            </div>
          </article>;
        })}
      </div>
    </section>
  </div>;
}
