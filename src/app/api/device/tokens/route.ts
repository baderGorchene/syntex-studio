import { getServerAuth, type AuthContext } from '@/lib/auth';
import { createDeviceToken, listDeviceTokens, revokeDeviceToken } from '@/lib/db';

// Device tokens are minted, listed and revoked only from a signed-in browser session (never with a device token,
// and not in local mode, where there is no cloud account to sync with).
function sessionUser(auth: AuthContext): string | Response {
  if (auth.isDevice) return Response.json({ error: 'Sign in on the web to manage devices.' }, { status: 403 });
  if (auth.isLocal) return Response.json({ error: 'Desktop connect needs the cloud app.' }, { status: 400 });
  const userId = auth.user?.id || auth.userId;
  return userId ? userId : Response.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET() {
  try {
    const userId = sessionUser(await getServerAuth());
    if (typeof userId !== 'string') return userId;
    return Response.json({ devices: await listDeviceTokens(userId) });
  } catch (error) {
    console.error('Failed to list devices:', error);
    return Response.json({ error: 'Could not load your devices.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const userId = sessionUser(await getServerAuth());
    if (typeof userId !== 'string') return userId;
    const body = await request.json().catch(() => null);
    const raw = typeof body?.label === 'string' ? body.label.trim() : '';
    if (raw.length > 80) return Response.json({ error: 'Keep the device name under 80 characters.' }, { status: 400 });
    const label = raw || `Desktop (${new Date().toISOString().slice(0, 10)})`;
    const { token } = await createDeviceToken(userId, label);
    return Response.json({ token }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Failed to create device token:', error);
    return Response.json({ error: 'Could not connect this device.' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const userId = sessionUser(await getServerAuth());
    if (typeof userId !== 'string') return userId;
    const id = new URL(request.url).searchParams.get('id') || '';
    if (!id || id.length > 64) return Response.json({ error: 'Choose a device to revoke.' }, { status: 400 });
    if (!(await revokeDeviceToken(id, userId))) return Response.json({ error: 'Device not found.' }, { status: 404 });
    return Response.json({ revoked: true });
  } catch (error) {
    console.error('Failed to revoke device:', error);
    return Response.json({ error: 'Could not revoke that device.' }, { status: 500 });
  }
}
