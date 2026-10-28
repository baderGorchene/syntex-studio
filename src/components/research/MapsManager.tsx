'use client';

import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { MapMenu } from './MapMenu';

/**
 * Every map in one place, outside the topbar dropdown: find, sort, open, rename, move and delete maps,
 * and start a new one. The rows are the dropdown's (MapMenu), laid out as a page.
 */
export function MapsManager({ onClose, children, ...menu }: Omit<ComponentProps<typeof MapMenu>, 'layout' | 'onManage'> & { onClose: () => void; children?: ReactNode }) {
  const dialog = useRef<HTMLElement>(null);
  const total = menu.projects.length + menu.personalProjects.length;

  // Escape closes (a rename in progress catches its own Escape first); focus goes back to whatever opened this.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, [onClose]);

  // Keep Tab inside the dialog.
  const trapTab = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab' || !dialog.current) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button, input, select, a[href], [tabindex]:not([tabindex="-1"])')].filter(el => !el.hasAttribute('disabled'));
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  return (
    <div className="note-editor-scrim" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialog} className="maps-manager" role="dialog" aria-modal="true" aria-labelledby="maps-manager-title" onKeyDown={trapTab}>
        <header className="note-editor-head">
          <h2 id="maps-manager-title">All maps <small>{total}</small></h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={20} strokeWidth={1.75} /></button>
        </header>
        {children}
        <div className="map-menu is-page">
          <MapMenu {...menu} layout="page" />
        </div>
      </section>
    </div>
  );
}
