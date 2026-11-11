// Desktop builds serve the app on loopback only. A DNS-rebound page reaches 127.0.0.1 under a foreign Host
// (and Origin), so the middleware rejects anything not addressed to localhost/127.0.0.1 on our own port.
// Pure, with no Next imports, so tests can load it through type-stripping.

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/;

/** `port` is process.env.PORT; when unset, any port is accepted but the hostname must still be loopback. */
export function isAllowedDesktopRequest(host: string | null, origin: string | null, port: string | undefined): boolean {
  const match = LOOPBACK_HOST.exec((host || '').toLowerCase());
  if (!match) return false;
  const hostPort = match[2];
  if (port && hostPort !== port) return false;
  if (origin === null) return true; // same-origin GETs and non-browser callers send none
  const expectedPort = port || hostPort;
  if (!expectedPort) return false;
  return origin === `http://127.0.0.1:${expectedPort}` || origin === `http://localhost:${expectedPort}`;
}
