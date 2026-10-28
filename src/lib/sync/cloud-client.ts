import fs from 'fs/promises';
import path from 'path';
import { LOCAL_FILES_PREFIX, LOCAL_FILE_TYPES, resolveLocalFile } from '../local-files.ts';
import type { CloudClient } from './engine.ts';
import type { GraphSnapshot } from './merge.ts';
import type { SyncAccount } from './store.ts';

// The desktop's HTTP client for the cloud's device routes. Statuses the engine handles come back as values;
// anything else (network, timeout, 401, 5xx, bad JSON) throws. Error messages never include the token.

/** An unexpected cloud answer. `status` is 0 when the request never got one. */
export class CloudError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isVersion = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function createCloudClient(account: Pick<SyncAccount, 'token' | 'cloudUrl'>, timeoutMs = 15_000): CloudClient {
  const base = account.cloudUrl.replace(/\/+$/, '');

  async function call(route: string, init: { method?: string; json?: unknown; form?: FormData } = {}) {
    let res: Response;
    try {
      res = await fetch(base + route, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${account.token}`,
          ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
        redirect: 'error', // never replay the token to wherever a redirect points
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new CloudError(`Could not reach the cloud (${error instanceof Error ? error.name : 'network error'}).`);
    }
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body: isObject(body) ? body : {} };
  }
  const unexpected = (what: string, status: number) => new CloudError(`Unexpected cloud answer to ${what} (HTTP ${status}).`, status);
  const mapPath = (id: string) => `/api/device/projects/${encodeURIComponent(id)}`;

  return {
    async listProjects() {
      const { status, body } = await call('/api/device/projects');
      const account = isObject(body.account) ? body.account : {};
      if (status !== 200 || typeof body.userId !== 'string' || !body.userId || !Array.isArray(body.projects)) {
        throw unexpected('the map list', status);
      }
      const projects = body.projects.filter((p): p is { id: string; title: string; version: number } =>
        isObject(p) && typeof p.id === 'string' && typeof p.title === 'string' && isVersion(p.version));
      return {
        userId: body.userId,
        account: {
          email: typeof account.email === 'string' ? account.email : null,
          name: typeof account.name === 'string' ? account.name : null
        },
        fileSync: body.fileSync === true,
        projects: projects.map(({ id, title, version }) => ({ id, title, version }))
      };
    },

    async getGraph(id) {
      const { status, body } = await call(`/api/graph?projectId=${encodeURIComponent(id)}`);
      if (status === 403 || status === 410) return { status };
      if (status !== 200 || typeof body.title !== 'string' || !Array.isArray(body.nodes) || !Array.isArray(body.relationships) || !isVersion(body.version)) {
        throw unexpected('a map download', status);
      }
      const graph = { title: body.title, nodes: body.nodes, relationships: body.relationships } as GraphSnapshot;
      return { status: 200, graph, version: body.version };
    },

    async putGraph(id, g, baseVersion) {
      const { status, body } = await call('/api/graph', {
        method: 'PUT',
        json: { projectId: id, nodes: g.nodes, relationships: g.relationships, baseVersion }
      });
      if ((status === 200 || status === 409) && isVersion(body.version)) return { status, version: body.version };
      if (status === 400 || status === 413) {
        return { status, error: typeof body.error === 'string' ? body.error : 'The cloud refused this map.' };
      }
      throw unexpected('a map upload', status);
    },

    async upsertProject(id, title) {
      const { status } = await call(mapPath(id), { method: 'PUT', json: { title } });
      if (status === 200 || status === 201 || status === 403) return { status };
      throw unexpected('a map create', status);
    },

    async deleteProject(id, baseVersion) {
      const { status, body } = await call(`${mapPath(id)}?baseVersion=${baseVersion}`, { method: 'DELETE' });
      if (status === 200 || status === 403 || status === 410) return { status };
      if (status === 409 && isVersion(body.version)) return { status, version: body.version };
      throw unexpected('a map delete', status);
    },

    async uploadFile(projectId, localUrl) {
      const root = process.env.SYNTHEX_UPLOAD_DIR;
      if (!root || !localUrl.startsWith(LOCAL_FILES_PREFIX)) throw new CloudError('Not a file stored on this device.');
      let segments: string[];
      try {
        segments = localUrl.slice(LOCAL_FILES_PREFIX.length).split('?')[0].split('/').map(decodeURIComponent);
      } catch {
        throw new CloudError('Not a file stored on this device.');
      }
      const target = resolveLocalFile(root, segments);
      if (!target) throw new CloudError('Not a file stored on this device.');

      const data = await fs.readFile(target);
      const type = LOCAL_FILE_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
      const form = new FormData();
      form.append('file', new Blob([data], { type }), path.basename(target));
      form.append('projectId', projectId);

      const { status, body } = await call('/api/upload', { method: 'POST', form });
      if (status !== 200 || typeof body.url !== 'string') throw unexpected('a file upload', status);
      // A relative URL or a data: URI means the cloud has no file storage this desktop could link to.
      if (!/^https?:\/\//i.test(body.url)) throw new CloudError('Cloud file storage is not available.');
      return body.url;
    }
  };
}
