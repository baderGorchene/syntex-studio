'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, LayoutGrid, LoaderCircle, MoreHorizontal, Pencil, Plus, Search, Trash2, UserRound, Users, X } from 'lucide-react';
import type { ResearchProject } from './WorkspaceSidebar';

type RowMode = 'actions' | 'rename' | 'delete';

interface MapMenuProps {
  projects: ResearchProject[];
  personalProjects: ResearchProject[];
  activeId: string;
  workspaceKind: 'personal' | 'team';
  onOpen: (id: string) => void;
  onMove: (id: string, workspace: 'team' | 'personal') => Promise<void> | void;
  /** Resolve true when the map was renamed. */
  onRename: (id: string, title: string) => Promise<boolean>;
  /** Resolve true when the map was deleted. */
  onDelete: (id: string) => Promise<boolean>;
  newTitle: string;
  onNewTitleChange: (value: string) => void;
  creating: boolean;
  onCreate: (event: FormEvent) => void;
  /** `page` is the full maps manager: search always on, a sort, and each map's date. `menu` is the topbar dropdown. */
  layout?: 'menu' | 'page';
  /** Opens the full maps manager (shown at the foot of the dropdown). */
  onManage?: () => void;
  /** Desktop sync: a short status beside a map's name, and extra row actions. */
  badgeFor?: (id: string) => string | null;
  extraActions?: (project: ResearchProject) => ReactNode;
  /** Web only: make a personal copy of a team map for the desktop app. */
  onCopyOffline?: (id: string) => void;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** The map switcher: open, rename, move and delete maps, and create a new one (pinned at the bottom). */
export function MapMenu({
  projects, personalProjects, activeId, workspaceKind, onOpen, onMove, onRename, onDelete,
  newTitle, onNewTitleChange, creating, onCreate, layout = 'menu', onManage, badgeFor, extraActions, onCopyOffline
}: MapMenuProps) {
  const isPage = layout === 'page';
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const [row, setRow] = useState<{ id: string; mode: RowMode } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const query = filter.trim().toLowerCase();
  const matches = (p: ResearchProject) => !query || p.title.toLowerCase().includes(query);
  // The dropdown keeps the server's order; the manager sorts by newest or by name.
  const order = (list: ResearchProject[]) => !isPage ? list : [...list].sort(sort === 'name'
    ? (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' })
    : (a, b) => b.createdAt - a.createdAt);
  const visibleProjects = order(projects.filter(matches));
  const visiblePersonal = order(personalProjects.filter(matches));
  const isTeam = workspaceKind === 'team';

  const toggleActions = (id: string) => setRow(current => current?.id === id ? null : { id, mode: 'actions' });
  const startRename = (p: ResearchProject) => { setRenameDraft(p.title); setRow({ id: p.id, mode: 'rename' }); };

  async function submitRename(event: FormEvent, id: string) {
    event.preventDefault();
    const title = renameDraft.trim();
    if (title.length < 2 || busy) return;
    setBusy(true);
    const ok = await onRename(id, title);
    setBusy(false);
    if (ok) setRow(null);
  }

  async function confirmDelete(id: string) {
    if (busy) return;
    setBusy(true);
    const ok = await onDelete(id);
    setBusy(false);
    if (ok) setRow(null);
  }

  function renderRow(p: ResearchProject, kind: 'workspace' | 'personal') {
    const isOpen = p.id === activeId;
    const mode = row?.id === p.id ? row.mode : null;
    // Personal maps are always the user's own; in a team only the creator may move or delete a map.
    const owns = kind === 'personal' || !isTeam || Boolean(p.isOwner);
    const title = p.title || 'Untitled map';
    const badge = badgeFor?.(p.id);

    if (mode === 'rename') {
      return (
        <li key={p.id} className="map-menu-row is-editing" role="none">
          <form className="map-menu-rename" onSubmit={event => void submitRename(event, p.id)}>
            <input
              className="field-input"
              value={renameDraft}
              onChange={event => setRenameDraft(event.target.value)}
              onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setRow(null); } }}
              maxLength={80}
              aria-label={`New name for “${title}”`}
              autoFocus
              onFocus={event => event.currentTarget.select()}
            />
            <button type="submit" className="map-menu-save" disabled={busy || renameDraft.trim().length < 2}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="map-menu-icon" aria-label="Cancel renaming" onClick={() => setRow(null)}><X size={14} /></button>
          </form>
        </li>
      );
    }

    return (
      <li key={p.id} className={`map-menu-row ${isOpen ? 'is-active' : ''} ${mode ? 'is-expanded' : ''}`} role="none">
        <div className="map-menu-line">
          {/* Personal maps open too, without leaving the team: only you can see them either way. */}
          <button
            type="button"
            role={isPage ? undefined : 'menuitemradio'}
            aria-checked={isPage ? undefined : isOpen}
            aria-current={isPage && isOpen ? 'true' : undefined}
            className="map-menu-open"
            title={isOpen ? `${title} (open now)` : `Open ${title}`}
            onClick={() => onOpen(p.id)}
          >
            <span className="map-menu-check" aria-hidden="true">{isOpen && <Check size={14} strokeWidth={2.25} />}</span>
            <span className="map-menu-name">{title}</span>
            {isPage && p.createdAt > 0 && <span className="map-menu-date">{dateFormat.format(p.createdAt)}</span>}
            {badge && <span className="map-menu-badge">{badge}</span>}
            {isOpen && <span className="map-menu-badge">Open</span>}
          </button>
          <button
            type="button"
            className={`map-menu-icon ${mode ? 'is-on' : ''}`}
            aria-label={`Options for “${title}”`}
            aria-expanded={Boolean(mode)}
            title="Rename, move or delete"
            onClick={() => toggleActions(p.id)}
          >
            <MoreHorizontal size={16} />
          </button>
        </div>

        {mode === 'actions' && (
          <div className="map-menu-actions">
            <button type="button" className="map-menu-action" onClick={() => startRename(p)}>
              <Pencil size={13} strokeWidth={1.75} aria-hidden="true" /> Rename
            </button>
            {kind === 'personal' && (
              <button type="button" className="map-menu-action" onClick={() => { setRow(null); void onMove(p.id, 'team'); }}>
                <Users size={13} strokeWidth={1.75} aria-hidden="true" /> Move to team
              </button>
            )}
            {kind === 'workspace' && isTeam && owns && (
              <button
                type="button"
                className="map-menu-action"
                title="Teammates lose access"
                onClick={() => {
                  if (window.confirm(`Move “${title}” to your personal maps? Teammates will lose access to it.`)) { setRow(null); void onMove(p.id, 'personal'); }
                }}
              >
                <UserRound size={13} strokeWidth={1.75} aria-hidden="true" /> Make personal
              </button>
            )}
            {kind === 'workspace' && isTeam && onCopyOffline && (
              <button type="button" className="map-menu-action" title="A personal copy you can sync to the desktop app. It never merges back." onClick={() => { setRow(null); onCopyOffline(p.id); }}>
                <Copy size={13} strokeWidth={1.75} aria-hidden="true" /> Make offline copy
              </button>
            )}
            {owns && (
              <button type="button" className="map-menu-action is-danger" onClick={() => setRow({ id: p.id, mode: 'delete' })}>
                <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" /> Delete
              </button>
            )}
            {extraActions?.(p)}
            {!owns && <span className="map-menu-note">Only its creator can move or delete this map.</span>}
          </div>
        )}

        {mode === 'delete' && (
          <div className="map-menu-confirm" role="alertdialog" aria-label={`Delete “${title}”?`}>
            <p>
              Delete <strong>{title}</strong>{isTeam && kind === 'workspace' ? ' for everyone in the team' : ''}? Its notes, links, research history and chat go with it. This can&apos;t be undone.
            </p>
            <div>
              <button type="button" className="map-menu-action" onClick={() => setRow(null)} disabled={busy}>Cancel</button>
              <button type="button" className="map-menu-danger" onClick={() => void confirmDelete(p.id)} disabled={busy} autoFocus>
                {busy ? 'Deleting…' : 'Delete map'}
              </button>
            </div>
          </div>
        )}
      </li>
    );
  }

  return (
    <>
      {(isPage || projects.length + personalProjects.length > 6) && (
        <div className="map-menu-tools">
          <div className="map-menu-search">
            <Search size={14} strokeWidth={1.75} aria-hidden="true" />
            <input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Find a map…" aria-label="Find a map" autoFocus />
          </div>
          {isPage && (
            <label className="map-menu-sort">
              <span className="sr-only">Sort maps</span>
              <select className="field-input" value={sort} onChange={event => setSort(event.target.value as 'recent' | 'name')}>
                <option value="recent">Newest first</option>
                <option value="name">By name</option>
              </select>
            </label>
          )}
        </div>
      )}
      <div className="map-menu-scroll">
        <section className="map-menu-section">
          <p className="map-menu-heading">
            <span>{isTeam ? 'Team maps' : 'Your maps'}</span>
            <small>{projects.length}</small>
          </p>
          <ul className="map-menu-list" role={isPage ? undefined : 'menu'} aria-label={isTeam ? 'Team maps' : 'Your maps'}>
            {visibleProjects.map(p => renderRow(p, 'workspace'))}
            {visibleProjects.length === 0 && (
              <li className="map-menu-empty" role="none">{query ? 'No maps match.' : 'No maps yet. Create one below.'}</li>
            )}
          </ul>
        </section>
        {isTeam && personalProjects.length > 0 && (
          <section className="map-menu-section map-menu-personal">
            <p className="map-menu-heading">
              <span>Your personal maps</span>
              <small>{personalProjects.length}</small>
            </p>
            <p className="map-menu-hint">Only you can see these. Open one here, or move it into the team so everyone can edit it.</p>
            <ul className="map-menu-list">
              {visiblePersonal.map(p => renderRow(p, 'personal'))}
              {visiblePersonal.length === 0 && <li className="map-menu-empty">No maps match.</li>}
            </ul>
          </section>
        )}
      </div>
      {onManage && (
        <button type="button" className="map-menu-manage" onClick={onManage}>
          <LayoutGrid size={14} strokeWidth={1.75} aria-hidden="true" /> Manage all maps
        </button>
      )}
      <form className="map-menu-new" onSubmit={onCreate}>
        <label className="map-menu-heading" htmlFor="project-name"><span>New map</span></label>
        <div className="map-menu-new-row">
          <input className="field-input" id="project-name" value={newTitle} onChange={event => onNewTitleChange(event.target.value)} maxLength={80} minLength={2} placeholder="e.g. Small language models" required />
          <button type="submit" className="map-menu-create" disabled={creating || newTitle.trim().length < 2}>
            {creating ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Plus size={14} strokeWidth={2} aria-hidden="true" />}
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </>
  );
}
