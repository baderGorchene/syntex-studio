'use client';
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useState } from 'react';
import { Download, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { RESEARCH_MODE_LABELS, type CanvasNode, type Connection, type DatabaseSnapshotSummary, type GraphRevisionSummary, type ResearchSession } from '@/types/canvas';
import type { WorkspaceSection } from './WorkspaceSidebar';
import { getLinkThumbnail } from './SourceMetadata';
import { nodeLabel } from './nodes/BaseKnowledgeCard';
import { FileViewerModal } from './FileAndMediaModal';
import { extractPageNumber } from '@/utils/citation';


function formatRelativeTime(timestamp: number): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

function sourceHost(value?: string) {
  try {
    const url = new URL(value || '');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : 'Invalid source URL';
  } catch { return 'Invalid source URL'; }
}

export function KnowledgeViews({
  section, nodes, edges, sessions, onSelectNode, onOpenSession, projectId, onRestoreRevision, onCreateCheckpoint, onRestoreDatabase
}: {
  section: WorkspaceSection;
  nodes: CanvasNode[];
  edges: Connection[];
  sessions: ResearchSession[];
  onSelectNode: (id: string) => void;
  onOpenSession: (session: ResearchSession) => void;
  projectId?: string;
  onRestoreRevision?: (revisionId: string) => Promise<void> | void;
  onCreateCheckpoint?: (title: string) => Promise<void> | void;
  onRestoreDatabase?: () => Promise<void> | void;
}) {
  const [activePdfPreview, setActivePdfPreview] = useState<{
    fileData: string;
    fileName?: string;
    fileSize?: number;
    fileType?: string;
    initialPage?: number;
    highlightExcerpt?: string;
  } | null>(null);

  if (section === 'revisions') {
    return (
      <RevisionsView
        projectId={projectId || 'default'}
        currentNodesCount={nodes.length}
        currentEdgesCount={edges.length}
        onRestoreRevision={onRestoreRevision}
        onCreateCheckpoint={onCreateCheckpoint}
        onRestoreDatabase={onRestoreDatabase}
      />
    );
  }

  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const sourceCount = nodes.filter(node => node.type === 'source' || node.type === 'link').length;
  // A card's sources: the evidence linked on it, plus any source card it is connected to on the map.
  const sourceNodeIds = new Set(nodes.filter(node => node.type === 'source' || node.type === 'link').map(node => node.id));
  const sourcesOf = (node: CanvasNode) => new Set([
    ...(node.metadata?.evidence ?? []).map(ev => ev.sourceId),
    ...edges.flatMap(edge => edge.from === node.id && sourceNodeIds.has(edge.to) ? [edge.to]
      : edge.to === node.id && sourceNodeIds.has(edge.from) ? [edge.from] : [])
  ]).size;

  if (section === 'history') {
    const waiting = sessions.filter(session => session.status === 'review').length;
    return (
      <div className="content-view">
        <ViewHead title="Research history" meta={`${count(sessions.length, 'run')}${waiting ? ` · ${waiting} waiting for review` : ''}`} />
        {sessions.length === 0 ? <EmptyView title="No research yet" body="Ask a question in the composer on the map. Each run shows up here with what you kept." /> :
          <ol className="view-rows">{sessions.map(session => {
            const kept = session.changes.filter(item => item.kind === 'node' && item.status === 'accepted').length;
            const discarded = session.changes.filter(item => item.kind === 'node' && item.status === 'rejected').length;
            const pending = session.status === 'review' || session.changes.some(item => item.status === 'pending');
            return <li key={session.id}><button className="view-row" onClick={() => onOpenSession(session)}>
              <span className="view-row-main">
                <strong>{session.query}</strong>
                {session.summary && <span className="view-row-body">{session.summary}</span>}
                <span className="note-meta">{[RESEARCH_MODE_LABELS[session.mode] ?? 'Research', `${kept} ${kept === 1 ? 'idea' : 'ideas'} kept`, `${discarded} discarded`, shortDate(session.createdAt)].join(' · ')}</span>
                {pending && <span className="view-row-draft">Drafts waiting on the map</span>}
              </span>
            </button></li>;
          })}</ol>}
      </div>
    );
  }

  if (section === 'evidence') {
    const claims = nodes.filter(node => node.type === 'claim');
    const withSources = claims.filter(claim => sourcesOf(claim) > 0).length;
    return <div className="content-view">
      <ViewHead title="Evidence paths" meta={`${count(claims.length, 'claim')} · ${withSources} with sources`} />
      {claims.length === 0 ? <EmptyView title="No claims to trace" body="Add a claim and connect it to the sources that support or challenge it." /> :
        <div className="view-paper">{claims.map(claim => {
          const related = edges.filter(edge => edge.from === claim.id || edge.to === claim.id);
          return <article className="evidence-path" key={claim.id}>
            <button className="evidence-path-claim" onClick={() => onSelectNode(claim.id)}>
              <strong>{claim.title}</strong>
              <ClaimStatus status={claim.metadata?.claimStatus} />
            </button>
            {claim.metadata?.evidence?.length ? (
              <ol className="evidence-path-sources">
                {claim.metadata.evidence.map((ev, idx) => {
                  const src = nodes.find(n => n.id === ev.sourceId);
                  const pageNum = ev.page || extractPageNumber(ev.location);
                  const hasPdf = Boolean(src?.fileData && (src.fileType?.includes('pdf') || src.fileName?.toLowerCase().endsWith('.pdf') || src.fileData.startsWith('data:application/pdf')));
                  return (
                    <li key={idx}>
                      <button
                        type="button"
                        title={ev.excerpt ? `“${ev.excerpt}”` : undefined}
                        onClick={() => {
                          if (hasPdf && src?.fileData) {
                            setActivePdfPreview({
                              fileData: src.fileData,
                              fileName: src.fileName || src.title,
                              fileSize: src.fileSize,
                              fileType: src.fileType || 'application/pdf',
                              initialPage: pageNum,
                              highlightExcerpt: ev.excerpt
                            });
                          } else if (src) {
                            onSelectNode(src.id);
                          }
                        }}
                      >
                        {src?.title || ev.sourceId}
                      </button>
                      <span className="note-meta">{[ev.relation === 'contradicts' ? 'Challenges it' : 'Supports it', pageNum ? `p. ${pageNum}` : null, hasPdf ? 'PDF' : null].filter(Boolean).join(' · ')}</span>
                    </li>
                  );
                })}
              </ol>
            ) : null}
            {related.length ? <ul className="evidence-path-links">{related.map(edge => {
              const otherId = edge.from === claim.id ? edge.to : edge.from;
              const other = nodes.find(node => node.id === otherId);
              return <li key={edge.id}><button onClick={() => onSelectNode(otherId)}><span className="evidence-path-label">{(edge.label || 'related to').replaceAll('_', ' ')}</span> {other?.title || 'Missing idea'}</button></li>;
            })}</ul> : <p className="note-meta">Not connected to anything yet.</p>}
          </article>;
        })}</div>}

      {activePdfPreview && (
        <FileViewerModal
          fileData={activePdfPreview.fileData}
          fileName={activePdfPreview.fileName}
          fileSize={activePdfPreview.fileSize}
          fileType={activePdfPreview.fileType}
          initialPage={activePdfPreview.initialPage}
          highlightExcerpt={activePdfPreview.highlightExcerpt}
          onClose={() => setActivePdfPreview(null)}
        />
      )}
    </div>;
  }

  if (section === 'table') {
    const rows = nodes.filter(node => node.type === 'claim' || node.type === 'question').sort((a, b) => a.title.localeCompare(b.title));
    const claimsCount = rows.filter(node => node.type === 'claim').length;
    return <div className="content-view">
      <ViewHead title="Claims and questions" meta={`${count(claimsCount, 'claim')} · ${count(rows.length - claimsCount, 'question')}`} />
      {rows.length === 0 ? <EmptyView title="Nothing here yet" body="Claims and questions from your map show up here with their status." /> :
        <div className="view-paper view-table-wrap">
          <table className="view-table">
            <thead><tr><th scope="col">Title</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col" className="num">Sources</th><th scope="col" className="num">Relations</th></tr></thead>
            <tbody>{rows.map(node => (
              <tr key={node.id}>
                <td><button type="button" onClick={() => onSelectNode(node.id)}>{node.title}</button></td>
                <td>{nodeLabel[node.type] || 'Idea'}</td>
                <td>{node.type === 'claim' ? <ClaimStatus status={node.metadata?.claimStatus} /> : <span className="claim-status muted">Open</span>}</td>
                <td className="num">{sourcesOf(node)}</td>
                <td className="num">{edges.filter(edge => edge.from === node.id || edge.to === node.id).length}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>}
    </div>;
  }

  let viewNodes = nodes;
  let title = 'Outline';
  let meta = `${count(nodes.length, 'idea')} · ${count(edges.length, 'relation')} · ${count(sourceCount, 'source')}`;
  let emptyBody = 'Add ideas on the map and they appear here in reading order.';
  if (section === 'sources') { viewNodes = nodes.filter(node => node.type === 'source' || node.type === 'link'); title = 'Sources'; meta = count(viewNodes.length, 'source'); emptyBody = 'Sources you add or keep from research are listed here, numbered.'; }
  if (section === 'questions') { viewNodes = nodes.filter(node => node.type === 'question'); title = 'Open questions'; meta = count(viewNodes.length, 'open question'); emptyBody = 'Questions on your map show up here so you know what to look into next.'; }
  if (section === 'outline') viewNodes = nodes.filter(node => !['source', 'link', 'image'].includes(node.type));
  const Rows = section === 'sources' ? 'ol' : 'ul';
  return <div className="content-view">
    <ViewHead title={title} meta={meta} />
    {viewNodes.length === 0 ? <EmptyView title="Nothing here yet" body={emptyBody} /> :
      <Rows className={`view-rows ${section === 'sources' ? 'is-numbered' : ''}`}>{viewNodes.sort((a, b) => a.y - b.y || a.title.localeCompare(b.title)).map(node => {
        const connectedCount = edges.filter(edge => edge.from === node.id || edge.to === node.id).length;
        const linkThumb = (node.type === 'source' || node.type === 'link') ? getLinkThumbnail(node) : null;
        const previewImage = linkThumb?.thumbnailUrl;
        const metaLine = [
          nodeLabel[node.type] || 'Idea',
          node.metadata?.origin === 'ai' ? 'From research' : null,
          node.url ? sourceHost(node.url) : null,
          connectedCount ? count(connectedCount, 'relation') : null
        ].filter(Boolean).join(' · ');
        return <li key={node.id}><button className="view-row" onClick={() => onSelectNode(node.id)}>
          <span className="view-row-main">
            <strong>{node.title}</strong>
            {(node.content || node.description) && <span className="view-row-body">{node.content || node.description}</span>}
            <span className="note-meta">{metaLine}{node.metadata?.claimStatus && <> · <ClaimStatus status={node.metadata.claimStatus} /></>}</span>
          </span>
          {previewImage && (
            <img
              src={previewImage}
              alt=""
              className="view-row-thumb"
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(e) => { (e.currentTarget as HTMLElement).style.display = 'none'; }}
            />
          )}
        </button></li>;
      })}</Rows>}
  </div>;
}

function ViewHead({ title, meta }: { title: string; meta: string }) {
  return <header className="view-head"><h1>{title}</h1><p className="view-meta">{meta}</p></header>;
}

function EmptyView({ title, body }: { title: string; body: string }) {
  return <div className="view-empty"><strong>{title}</strong><p>{body}</p></div>;
}

const STATUS_GLYPH: Record<string, [string, string]> = {
  supported: ['●', 'ink'], weakly_supported: ['◐', 'muted'], disputed: ['◐', 'muted'], contradicted: ['◐', 'muted'],
  unverified: ['○', 'faint'], open_question: ['○', 'faint'], outdated: ['○', 'faint']
};

/** Claim status as text with a small leading glyph; the word is always shown. */
function ClaimStatus({ status = 'unverified' }: { status?: string }) {
  const [glyph, tone] = STATUS_GLYPH[status] || STATUS_GLYPH.unverified;
  const word = status.replaceAll('_', ' ');
  return <span className={`claim-status ${tone}`}><span aria-hidden="true">{glyph}</span> {word.charAt(0).toUpperCase() + word.slice(1)}</span>;
}

function shortDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function RevisionsView({
  projectId,
  currentNodesCount,
  currentEdgesCount,
  onRestoreRevision,
  onCreateCheckpoint,
  onRestoreDatabase
}: {
  projectId: string;
  currentNodesCount: number;
  currentEdgesCount: number;
  onRestoreRevision?: (revisionId: string) => Promise<void> | void;
  onCreateCheckpoint?: (title: string) => Promise<void> | void;
  onRestoreDatabase?: () => Promise<void> | void;
}) {
  const [activeTab, setActiveTab] = useState<'revisions' | 'snapshots'>('revisions');

  // Revisions state
  const [revisions, setRevisions] = useState<GraphRevisionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [checkpointTitle, setCheckpointTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [showCreateInput, setShowCreateInput] = useState(false);

  // Snapshots state
  const [snapshots, setSnapshots] = useState<DatabaseSnapshotSummary[]>([]);
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);
  const [snapshotLabel, setSnapshotLabel] = useState('');
  const [creatingSnapshot, setCreatingSnapshot] = useState(false);
  const [showSnapshotInput, setShowSnapshotInput] = useState(false);
  const [restoringSnapshotFile, setRestoringSnapshotFile] = useState<string | null>(null);
  const [deletingSnapshotFile, setDeletingSnapshotFile] = useState<string | null>(null);

  const fetchRevisions = useCallback(async () => {
    try {
      const res = await fetch(`/api/revisions?projectId=${encodeURIComponent(projectId)}`);
      const data = await res.json();
      if (data.revisions) {
        setRevisions(data.revisions);
      }
    } catch (err) {
      console.error('Failed to fetch revisions:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const fetchSnapshots = useCallback(async () => {
    setLoadingSnapshots(true);
    try {
      const res = await fetch('/api/backup');
      const data = await res.json();
      if (data.snapshots) {
        setSnapshots(data.snapshots);
      }
    } catch (err) {
      console.error('Failed to fetch snapshots:', err);
    } finally {
      setLoadingSnapshots(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/revisions?projectId=${encodeURIComponent(projectId)}`)
      .then(res => res.json())
      .then(data => {
        if (!cancelled && data.revisions) {
          setRevisions(data.revisions);
        }
      })
      .catch(err => console.error('Failed to fetch revisions:', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!checkpointTitle.trim() && !onCreateCheckpoint) return;
    setCreating(true);
    try {
      if (onCreateCheckpoint) {
        await onCreateCheckpoint(checkpointTitle.trim());
      } else {
        await fetch('/api/revisions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            action: 'create',
            title: checkpointTitle.trim() || 'Manual Checkpoint'
          })
        });
      }
      setCheckpointTitle('');
      setShowCreateInput(false);
      await fetchRevisions();
    } finally {
      setCreating(false);
    }
  };

  const handleRestore = async (id: string, title: string) => {
    const confirmRestore = window.confirm(`Restore "${title}"? Your current map is saved as a version first, so you can come back to it.`);
    if (!confirmRestore) return;

    setRestoringId(id);
    try {
      if (onRestoreRevision) {
        await onRestoreRevision(id);
      } else {
        await fetch('/api/revisions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, action: 'restore', revisionId: id })
        });
      }
      await fetchRevisions();
    } finally {
      setRestoringId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await fetch('/api/revisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, action: 'delete', revisionId: id })
      });
      setRevisions(current => current.filter(rev => rev.id !== id));
    } finally {
      setDeletingId(null);
    }
  };

  const handleCreateSnapshot = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingSnapshot(true);
    try {
      const res = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', label: snapshotLabel.trim() || undefined })
      });
      const data = await res.json();
      if (data.success && data.snapshot) {
        setSnapshots(curr => [data.snapshot, ...curr]);
        setSnapshotLabel('');
        setShowSnapshotInput(false);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not make a backup');
    } finally {
      setCreatingSnapshot(false);
    }
  };

  const handleRestoreSnapshot = async (fileName: string, label: string) => {
    const confirmed = window.confirm(
      `RESTORE DATABASE SNAPSHOT\n\nAre you sure you want to restore "${label}"?\n\nThis will overwrite the entire canvas.db database with this snapshot. All workspaces will revert to the snapshot state.`
    );
    if (!confirmed) return;

    setRestoringSnapshotFile(fileName);
    try {
      const res = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restore', fileName })
      });
      const data = await res.json();
      if (data.success) {
        if (onRestoreDatabase) {
          await onRestoreDatabase();
        } else {
          window.location.reload();
        }
      } else {
        alert(data.error || 'Could not restore the backup');
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not restore the backup');
    } finally {
      setRestoringSnapshotFile(null);
    }
  };

  const handleDeleteSnapshot = async (fileName: string) => {
    const confirmed = window.confirm(`Delete the backup "${fileName}"? This cannot be undone.`);
    if (!confirmed) return;

    setDeletingSnapshotFile(fileName);
    try {
      await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', fileName })
      });
      setSnapshots(curr => curr.filter(s => s.fileName !== fileName));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not delete the backup');
    } finally {
      setDeletingSnapshotFile(null);
    }
  };

  const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="content-view">
      <ViewHead
        title="Revisions"
        meta={activeTab === 'revisions'
          ? `${revisions.length} saved ${revisions.length === 1 ? 'version' : 'versions'} · now ${currentNodesCount} ideas, ${currentEdgesCount} relations`
          : `${snapshots.length} ${snapshots.length === 1 ? 'backup' : 'backups'} of every map on this computer`}
      />

      <div className="view-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={activeTab === 'revisions'} className={activeTab === 'revisions' ? 'active' : ''} onClick={() => { setActiveTab('revisions'); fetchRevisions(); }}>
          This map ({revisions.length})
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'snapshots'} className={activeTab === 'snapshots' ? 'active' : ''} onClick={() => { setActiveTab('snapshots'); fetchSnapshots(); }}>
          Backups ({snapshots.length})
        </button>
      </div>

      {activeTab === 'revisions' ? (
        <>
          <div className="view-toolbar">
            {showCreateInput ? (
              <form onSubmit={handleCreate} className="view-toolbar-form">
                <input
                  type="text"
                  className="field-input"
                  aria-label="Version name"
                  placeholder="e.g. Before merging my notes"
                  value={checkpointTitle}
                  autoFocus
                  onChange={e => setCheckpointTitle(e.target.value)}
                  disabled={creating}
                />
                <button type="submit" className="ink-button" disabled={creating}>{creating ? 'Saving…' : 'Save'}</button>
                <button type="button" className="text-button" onClick={() => { setShowCreateInput(false); setCheckpointTitle(''); }} disabled={creating}>Cancel</button>
              </form>
            ) : (
              <button type="button" className="line-button" onClick={() => setShowCreateInput(true)}>
                <Plus size={16} strokeWidth={1.75} /> Save a version
              </button>
            )}
          </div>

          {loading ? (
            <div className="view-empty"><strong>Loading versions…</strong></div>
          ) : revisions.length === 0 ? (
            <EmptyView title="No versions yet" body="Versions are saved as you work. You can also save one by hand before a big change." />
          ) : (
            <ol className="view-rows">
              {revisions.map(rev => {
                const isRestoring = restoringId === rev.id;
                const isDeleting = deletingId === rev.id;
                return (
                  <li className="view-row is-static" key={rev.id}>
                    <span className="view-row-main">
                      <strong>{rev.title}</strong>
                      <span className="note-meta">{formatRelativeTime(rev.createdAt)} · {time(rev.createdAt)} · {rev.nodeCount} ideas · {rev.edgeCount} relations</span>
                    </span>
                    <span className="view-row-actions">
                      <button type="button" className="line-button" disabled={isRestoring || isDeleting} onClick={() => handleRestore(rev.id, rev.title)}>
                        {isRestoring ? 'Restoring…' : 'Restore'}
                      </button>
                      <button type="button" className="icon-button" disabled={isRestoring || isDeleting} onClick={() => handleDelete(rev.id)} aria-label={`Delete version ${rev.title}`} title="Delete this version">
                        {isDeleting ? <LoaderCircle size={16} strokeWidth={1.75} className="spin" /> : <Trash2 size={16} strokeWidth={1.75} />}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      ) : (
        <>
          <div className="view-toolbar">
            {showSnapshotInput ? (
              <form onSubmit={handleCreateSnapshot} className="view-toolbar-form">
                <input
                  type="text"
                  className="field-input"
                  aria-label="Backup name"
                  placeholder="e.g. Before importing a big file"
                  value={snapshotLabel}
                  autoFocus
                  onChange={e => setSnapshotLabel(e.target.value)}
                  disabled={creatingSnapshot}
                />
                <button type="submit" className="ink-button" disabled={creatingSnapshot}>{creatingSnapshot ? 'Backing up…' : 'Back up'}</button>
                <button type="button" className="text-button" onClick={() => { setShowSnapshotInput(false); setSnapshotLabel(''); }} disabled={creatingSnapshot}>Cancel</button>
              </form>
            ) : (
              <>
                <button type="button" className="line-button" onClick={() => setShowSnapshotInput(true)}>
                  <Plus size={16} strokeWidth={1.75} /> Make a backup
                </button>
                <a href="/api/backup?download=1" className="text-button view-link-button">
                  <Download size={16} strokeWidth={1.75} /> Download the database
                </a>
              </>
            )}
          </div>

          {loadingSnapshots ? (
            <div className="view-empty"><strong>Loading backups…</strong></div>
          ) : snapshots.length === 0 ? (
            <EmptyView title="No backups yet" body="A backup copies every map on this computer into one file you can restore later." />
          ) : (
            <ol className="view-rows">
              {snapshots.map(snap => {
                const isRestoring = restoringSnapshotFile === snap.fileName;
                const isDeleting = deletingSnapshotFile === snap.fileName;
                return (
                  <li className="view-row is-static" key={snap.id}>
                    <span className="view-row-main">
                      <strong>{snap.label}</strong>
                      <span className="note-meta">{formatRelativeTime(snap.createdAt)} · {time(snap.createdAt)} · {formatBytes(snap.sizeBytes)} · {snap.projectCount} maps · {snap.nodeCount} ideas · {snap.fileName}</span>
                    </span>
                    <span className="view-row-actions">
                      <a href={`/api/backup?download=1&fileName=${encodeURIComponent(snap.fileName)}`} className="text-button view-link-button" title="Download this backup">Download</a>
                      <button type="button" className="line-button" disabled={isRestoring || isDeleting} onClick={() => handleRestoreSnapshot(snap.fileName, snap.label)}>
                        {isRestoring ? 'Restoring…' : 'Restore'}
                      </button>
                      <button type="button" className="icon-button" disabled={isRestoring || isDeleting} onClick={() => handleDeleteSnapshot(snap.fileName)} aria-label={`Delete backup ${snap.label}`} title="Delete this backup">
                        {isDeleting ? <LoaderCircle size={16} strokeWidth={1.75} className="spin" /> : <Trash2 size={16} strokeWidth={1.75} />}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
