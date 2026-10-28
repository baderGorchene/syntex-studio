'use client';

import { useEffect, useState } from 'react';

interface Device { id: string; label: string; createdAt: number; lastUsedAt: number | null }

const day = (time: number) => new Date(time).toLocaleDateString();

export function ConnectDesktop() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => fetch('/api/device/tokens')
    .then(response => response.ok ? response.json() : Promise.reject(new Error()))
    .then(data => setDevices(data.devices))
    .catch(() => setError('Could not load your devices.'));

  useEffect(() => { load(); }, []);

  async function connect() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/device/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: `Desktop (${new Date().toLocaleDateString()})` })
      });
      const data = await response.json();
      if (!response.ok || typeof data.token !== 'string') throw new Error(data.error);
      location.href = 'synthex://connect?token=' + encodeURIComponent(data.token);
      load();
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Could not connect this desktop.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    const response = await fetch(`/api/device/tokens?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) setError('Could not revoke that device.');
    load();
  }

  return (
    <>
      <h2>Connect your desktop</h2>
      <p>The desktop app will sync your personal maps with this account. Team maps stay on the web.</p>
      <button type="button" className="ink-button" onClick={connect} disabled={busy}>
        {busy ? 'Connecting…' : 'Connect this desktop'}
      </button>
      {error && <p role="alert">{error}</p>}
      {devices.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: 24 }}>
          {devices.map(device => (
            <li key={device.id} style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
              <span>
                {device.label}
                <span className="note-meta"> · added {day(device.createdAt)}{device.lastUsedAt ? ` · last synced ${day(device.lastUsedAt)}` : ''}</span>
              </span>
              <button type="button" className="line-button" onClick={() => revoke(device.id)}>Revoke</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
