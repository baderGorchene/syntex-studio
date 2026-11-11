import { createProjectInDb, deleteProjectFromDb, getGraphVersion, projectExistsInDb, renameProjectInDb, userHasProjectAccess } from '@/lib/db';
import { deviceProjectDenied, getServerAuth } from '@/lib/auth';
import { syncGraphVectors } from '@/lib/rag/vector-store';

type Context = { params: Promise<{ id: string }> };

const validId = (id: string) => id.startsWith('project-') && id.length <= 80;

/** Desktop sync: create a personal map with this id, or rename it if it's already this user's personal map. */
export async function PUT(request: Request, context: Context) {
  try {
    const auth = await getServerAuth();
    if (!auth.isDevice) return Response.json({ error: 'Not found.' }, { status: 404 });
    const userId = auth.user?.id || auth.userId;

    const { id } = await context.params;
    if (!validId(id)) return Response.json({ error: 'Invalid map id.' }, { status: 400 });
    const body = await request.json().catch(() => null);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (title.length < 1 || title.length > 255) {
      return Response.json({ error: 'Give the map a name between 1 and 255 characters.' }, { status: 400 });
    }

    if (await userHasProjectAccess(id, userId, null, auth.clerkId, true)) {
      await renameProjectInDb(id, title);
      return Response.json({ project: { id, title, version: await getGraphVersion(id) } });
    }
    // Someone else's map, or a team map: never re-home or rename it.
    if (await projectExistsInDb(id)) return deviceProjectDenied(id);
    await createProjectInDb(id, title, userId, null);
    return Response.json({ project: { id, title, version: await getGraphVersion(id) } }, { status: 201 });
  } catch (error) {
    console.error('Failed to save device project:', error);
    return Response.json({ error: 'Could not save that map.' }, { status: 500 });
  }
}

/** Desktop sync: delete a personal map, only if nobody saved it since `baseVersion`. */
export async function DELETE(request: Request, context: Context) {
  try {
    const auth = await getServerAuth();
    if (!auth.isDevice) return Response.json({ error: 'Not found.' }, { status: 404 });
    const userId = auth.user?.id || auth.userId;

    const { id } = await context.params;
    if (!validId(id)) return Response.json({ error: 'Invalid map id.' }, { status: 400 });
    const raw = new URL(request.url).searchParams.get('baseVersion') || '';
    const baseVersion = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(baseVersion)) {
      return Response.json({ error: 'baseVersion must be a non-negative integer.' }, { status: 400 });
    }

    if (!(await userHasProjectAccess(id, userId, null, auth.clerkId, true))) return deviceProjectDenied(id);
    // ponytail: compare-then-delete; a save landing between these two calls is deleted with the map.
    // A conditional delete (WHERE graphVersion = ?) inside deleteProjectFromDb would close the race.
    const version = await getGraphVersion(id);
    if (version !== baseVersion) return Response.json({ error: 'This map changed elsewhere.', version }, { status: 409 });
    if (!(await deleteProjectFromDb(id, userId, auth.clerkId))) return deviceProjectDenied(id);

    try {
      await syncGraphVectors(id, []);
    } catch (error) {
      console.warn('Could not clear the search index of a deleted map:', error);
    }
    return Response.json({ deleted: true });
  } catch (error) {
    console.error('Failed to delete device project:', error);
    return Response.json({ error: 'Could not delete that map.' }, { status: 500 });
  }
}
