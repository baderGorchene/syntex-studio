import { getGraphVersion, getProjectsFromDb } from '@/lib/db';
import { getServerAuth } from '@/lib/auth';

/** Desktop sync: the account behind this device token and its personal maps with their graph versions. */
export async function GET() {
  try {
    const auth = await getServerAuth();
    if (!auth.isDevice) return Response.json({ error: 'Not found.' }, { status: 404 });
    const userId = auth.user?.id || auth.userId;

    const projects = await getProjectsFromDb(userId, null, auth.clerkId);
    // ponytail: one version query per map; select graphVersion in getProjectsFromDb if map counts grow large.
    const versions = await Promise.all(projects.map(project => getGraphVersion(project.id)));
    return Response.json({
      userId,
      account: { email: auth.user?.email ?? null, name: auth.user?.name ?? null },
      fileSync: Boolean(process.env.GCS_BUCKET_NAME),
      projects: projects.map((project, index) => ({ id: project.id, title: project.title, version: versions[index] }))
    });
  } catch (error) {
    console.error('Failed to list device projects:', error);
    return Response.json({ error: 'Could not load projects.' }, { status: 500 });
  }
}
