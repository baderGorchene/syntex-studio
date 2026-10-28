import { randomUUID } from 'node:crypto';
import { indexGraphNodes } from '@/lib/ai-service';
import { bulkSaveCanvasToDb, createProjectInDb, deleteProjectFromDb, getAllConnectionsFromDb, getAllNodesFromDb, getProjectTitle, userHasProjectAccess } from '@/lib/db';
import { getServerAuth } from '@/lib/auth';
import { normalizeGraph } from '@/lib/graph';
import { copyGraphWithNewIds } from '@/lib/sync/copy';
import type { CanvasNode, Connection } from '@/types/canvas';

const SUFFIX = ' (offline copy)';

/** Makes a personal copy of a map you can open ({ projectId }), for use offline on the desktop app. The copy never merges back. */
export async function POST(request: Request) {
  try {
    const auth = await getServerAuth();
    const userId = auth.user?.id || auth.userId;
    if (!auth.isLocal && !userId) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (auth.isDevice) return Response.json({ error: 'Make offline copies in the web app.' }, { status: 403 });
    if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
      return Response.json({ error: 'Expected JSON.' }, { status: 415 });
    }

    const body = await request.json().catch(() => null);
    const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
    if (!projectId || projectId.length > 80 || !(await userHasProjectAccess(projectId, userId, auth.orgId, auth.clerkId))) {
      return Response.json({ error: 'Map not found.' }, { status: 404 });
    }

    const graph = normalizeGraph((await getAllNodesFromDb(projectId)) as CanvasNode[], (await getAllConnectionsFromDb(projectId)) as Connection[]);
    const title = ((await getProjectTitle(projectId)) || '').trim() || 'Untitled map';
    const copy = copyGraphWithNewIds({ title, nodes: Object.values(graph.nodesById), relationships: Object.values(graph.edgesById) }, randomUUID);

    // Personal: owned by the user, no organization.
    const project = await createProjectInDb(`project-${randomUUID()}`, `${title.slice(0, 80 - SUFFIX.length)}${SUFFIX}`, userId, null);
    try {
      const saved = await bulkSaveCanvasToDb(copy.nodes, copy.relationships, project.id);
      if (!saved.saved) throw new Error('Save of the copy was refused.');
    } catch (error) {
      // Never leave an empty half-made copy behind.
      console.error('Failed to save offline copy:', error);
      await Promise.resolve(deleteProjectFromDb(project.id, userId, auth.clerkId)).catch(e => console.error('Failed to clean up offline copy:', e));
      return Response.json({ error: 'Could not make an offline copy.' }, { status: 500 });
    }
    try { indexGraphNodes(project.id, copy.nodes); } catch (error) { console.warn('Could not index the offline copy:', error); }
    return Response.json({ project }, { status: 201 });
  } catch (error) {
    console.error('Failed to copy project:', error);
    return Response.json({ error: 'Could not make an offline copy.' }, { status: 500 });
  }
}
