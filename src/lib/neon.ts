/**
 * Synthex Studio: Neon Serverless PostgreSQL Database Engine
 * Pure HTTP serverless client for durable, production-grade cloud persistence.
 * Zero native binary dependencies, 100% compatible with Vercel and AWS Lambda.
 */

import { neon } from '@neondatabase/serverless';
import type {
  AccentColor,
  ArrowheadType,
  CanvasNode,
  CanvasNodeType,
  Connection,
  ConnectionColor,
  ConnectionLineStyle,
  ConnectionStrokePattern,
  GraphRevision,
  GraphRevisionSummary,
  ResearchChangeStatus,
  ResearchSession
} from '../types/canvas';
import { addNode, addRelationship, normalizeGraph } from './graph.ts';
import type { ChatMessageRecord, CreditTransaction, ResearchProject, SaveResult, UserRecord } from './db.ts';

export function isNeonConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.STORAGE_URL);
}

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.STORAGE_URL;
  if (!url) {
    throw new Error('Neon database connection string (DATABASE_URL, POSTGRES_URL, or STORAGE_URL) is not set.');
  }
  return url;
}

function getSql() {
  return neon(getDatabaseUrl());
}

let schemaInitializationPromise: Promise<void> | null = null;
let isInitializingSchema = false;

export async function ensureNeonSchema(): Promise<void> {
  if (!isNeonConfigured()) return;
  if (isInitializingSchema) return;
  if (!schemaInitializationPromise) {
    schemaInitializationPromise = (async () => {
      isInitializingSchema = true;
      try {
        const sql = getSql();

      // 1. Create tables if not exists
      await sql`
        CREATE TABLE IF NOT EXISTS users (
          id VARCHAR(64) PRIMARY KEY,
          clerk_id VARCHAR(128) UNIQUE NOT NULL,
          email VARCHAR(255),
          name VARCHAR(255),
          stripe_customer_id VARCHAR(128) UNIQUE,
          stripe_subscription_id VARCHAR(128),
          subscription_tier VARCHAR(32) NOT NULL DEFAULT 'trial',
          subscription_status VARCHAR(32) NOT NULL DEFAULT 'active',
          seat_count INTEGER DEFAULT 1,
          billing_interval VARCHAR(32) DEFAULT 'month',
          current_period_end BIGINT,
          context_credits INTEGER NOT NULL DEFAULT 100,
          trial_ends_at BIGINT,
          created_at BIGINT NOT NULL
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_users_clerk_id ON users(clerk_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON users(stripe_customer_id)`;

      await sql`
        CREATE TABLE IF NOT EXISTS credit_transactions (
          id VARCHAR(64) PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          amount INTEGER NOT NULL,
          action VARCHAR(64) NOT NULL,
          balance_after INTEGER NOT NULL,
          metadata TEXT,
          created_at BIGINT NOT NULL
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_credit_tx_user_created ON credit_transactions(user_id, created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS projects (
          id VARCHAR(128) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          user_id VARCHAR(128),
          organization_id VARCHAR(128),
          created_at BIGINT NOT NULL,
          graph_version INTEGER NOT NULL DEFAULT 0
        )
      `;
      await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS graph_version INTEGER NOT NULL DEFAULT 0`;

      await sql`CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)`;

      await sql`
        CREATE TABLE IF NOT EXISTS nodes (
          id VARCHAR(128) NOT NULL,
          project_id VARCHAR(128) NOT NULL,
          user_id VARCHAR(128),
          organization_id VARCHAR(128),
          type VARCHAR(32) NOT NULL,
          x DOUBLE PRECISION NOT NULL,
          y DOUBLE PRECISION NOT NULL,
          width DOUBLE PRECISION,
          height DOUBLE PRECISION,
          color VARCHAR(32),
          title TEXT NOT NULL,
          content TEXT,
          items TEXT,
          image_url TEXT,
          caption TEXT,
          url TEXT,
          domain VARCHAR(255),
          description TEXT,
          section_id VARCHAR(128),
          file_data TEXT,
          file_name VARCHAR(255),
          file_size BIGINT,
          file_type VARCHAR(32),
          page_count INTEGER,
          metadata TEXT,
          created_at BIGINT NOT NULL,
          PRIMARY KEY (project_id, id)
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id)`;

      await sql`
        CREATE TABLE IF NOT EXISTS connections (
          id VARCHAR(128) NOT NULL,
          project_id VARCHAR(128) NOT NULL,
          user_id VARCHAR(128),
          organization_id VARCHAR(128),
          from_node VARCHAR(128) NOT NULL,
          to_node VARCHAR(128) NOT NULL,
          label VARCHAR(64),
          arrowhead VARCHAR(32) DEFAULT 'end',
          line_style VARCHAR(32) DEFAULT 'curved',
          stroke_pattern VARCHAR(32) DEFAULT 'solid',
          color VARCHAR(32) DEFAULT 'neutral',
          animated BOOLEAN DEFAULT TRUE,
          metadata TEXT,
          created_at BIGINT NOT NULL,
          PRIMARY KEY (project_id, id)
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_connections_project ON connections(project_id)`;

      await sql`
        CREATE TABLE IF NOT EXISTS research_sessions (
          id VARCHAR(128) PRIMARY KEY,
          project_id VARCHAR(128) NOT NULL,
          user_id VARCHAR(128),
          organization_id VARCHAR(128),
          query TEXT NOT NULL,
          mode VARCHAR(32) NOT NULL,
          status VARCHAR(32) NOT NULL,
          summary TEXT NOT NULL,
          trail TEXT NOT NULL,
          changes TEXT NOT NULL,
          created_at BIGINT NOT NULL
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_research_sessions_project ON research_sessions(project_id, created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id VARCHAR(64) PRIMARY KEY,
          project_id VARCHAR(128) NOT NULL,
          thread_id VARCHAR(64) NOT NULL,
          user_key VARCHAR(128) NOT NULL,
          role VARCHAR(16) NOT NULL,
          content TEXT NOT NULL,
          referenced_node_ids TEXT NOT NULL DEFAULT '[]',
          tool_call TEXT,
          provider VARCHAR(32),
          model VARCHAR(64),
          created_at BIGINT NOT NULL
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(project_id, user_key, thread_id, created_at DESC)`;

      await sql`
        CREATE TABLE IF NOT EXISTS graph_revisions (
          id VARCHAR(128) PRIMARY KEY,
          project_id VARCHAR(128) NOT NULL,
          title VARCHAR(255) NOT NULL,
          node_count INTEGER NOT NULL,
          edge_count INTEGER NOT NULL,
          graph_data TEXT NOT NULL,
          created_at BIGINT NOT NULL
        )
      `;

      await sql`CREATE INDEX IF NOT EXISTS idx_graph_revisions_project ON graph_revisions(project_id, created_at DESC)`;

      // Auto-widen existing columns if created with earlier narrower definitions
      try { await sql`ALTER TABLE projects ALTER COLUMN id TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE projects ALTER COLUMN user_id TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE nodes ALTER COLUMN id TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE nodes ALTER COLUMN project_id TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE nodes ALTER COLUMN user_id TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE nodes ALTER COLUMN section_id TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE connections ALTER COLUMN id TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE connections ALTER COLUMN project_id TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE connections ALTER COLUMN user_id TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE connections ALTER COLUMN from_node TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE connections ALTER COLUMN to_node TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE connections ALTER COLUMN label TYPE VARCHAR(255)`; } catch {}
      try { await sql`ALTER TABLE research_sessions ALTER COLUMN id TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE research_sessions ALTER COLUMN project_id TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE research_sessions ALTER COLUMN user_id TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE graph_revisions ALTER COLUMN id TYPE VARCHAR(128)`; } catch {}
      try { await sql`ALTER TABLE graph_revisions ALTER COLUMN project_id TYPE VARCHAR(128)`; } catch {}

      // 2. Ensure default workspace exists
      const existingProjects = await sql`SELECT id FROM projects WHERE id = 'default' LIMIT 1`;
      if (existingProjects.length === 0) {
        await sql`
          INSERT INTO projects (id, title, created_at)
          VALUES ('default', 'Research workspace', ${Date.now()})
          ON CONFLICT (id) DO NOTHING
        `;
      }
    } finally {
      isInitializingSchema = false;
    }
  })().catch(err => {
    schemaInitializationPromise = null;
    isInitializingSchema = false;
    console.error('Neon schema initialization failed:', err);
    throw err;
  });
  }

  return schemaInitializationPromise;
}

// ============================================================================
// Projects
// ============================================================================

export async function neonGetProjects(
  userId?: string | null,
  orgId?: string | null,
  clerkId?: string | null
): Promise<ResearchProject[]> {
  await ensureNeonSchema();
  const sql = getSql();
  // Team active: the team's maps. Otherwise: the user's personal maps (not the ones they made inside a team).
  let rows;
  if (orgId) {
    rows = await sql`
      SELECT id, title, user_id, organization_id, created_at
      FROM projects
      WHERE organization_id = ${orgId}
      ORDER BY created_at ASC
    `;
  } else if (userId || clerkId) {
    rows = await sql`
      SELECT id, title, user_id, organization_id, created_at
      FROM projects
      WHERE organization_id IS NULL AND (
        (${userId || null}::varchar IS NOT NULL AND user_id = ${userId || null}) OR
        (${clerkId || null}::varchar IS NOT NULL AND user_id = ${clerkId || null})
      )
      ORDER BY created_at ASC
    `;
  } else {
    return [];
  }
  return rows.map(r => ({
    id: String(r.id),
    title: String(r.title),
    userId: r.user_id ? String(r.user_id) : null,
    organizationId: r.organization_id ? String(r.organization_id) : null,
    createdAt: Number(r.created_at)
  }));
}

export async function neonMoveProjectToWorkspace(
  id: string,
  orgId: string | null,
  userId?: string | null,
  clerkId?: string | null
): Promise<boolean> {
  await ensureNeonSchema();
  const sql = getSql();
  if (!userId && !clerkId) return false;
  const rows = await sql`
    UPDATE projects SET organization_id = ${orgId}
    WHERE id = ${id} AND (
      (${userId || null}::varchar IS NOT NULL AND user_id = ${userId || null}) OR
      (${clerkId || null}::varchar IS NOT NULL AND user_id = ${clerkId || null})
    )
    RETURNING id
  `;
  return rows.length > 0;
}

export async function neonRenameProject(id: string, title: string): Promise<boolean> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = await sql`UPDATE projects SET title = ${title} WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function neonDeleteProject(id: string, userId?: string | null, clerkId?: string | null): Promise<boolean> {
  await ensureNeonSchema();
  const sql = getSql();
  if (!userId && !clerkId) return false;
  const owned = await sql`
    SELECT 1 FROM projects
    WHERE id = ${id} AND (
      (${userId || null}::varchar IS NOT NULL AND user_id = ${userId || null}) OR
      (${clerkId || null}::varchar IS NOT NULL AND user_id = ${clerkId || null})
    )
    LIMIT 1
  `;
  if (owned.length === 0) return false;
  // Tables created by auto-init have no foreign keys, so every project-scoped table is cleared explicitly.
  await sql.transaction([
    sql`DELETE FROM connections WHERE project_id = ${id}`,
    sql`DELETE FROM nodes WHERE project_id = ${id}`,
    sql`DELETE FROM research_sessions WHERE project_id = ${id}`,
    sql`DELETE FROM graph_revisions WHERE project_id = ${id}`,
    sql`DELETE FROM chat_messages WHERE project_id = ${id}`,
    sql`DELETE FROM projects WHERE id = ${id}`
  ]);
  return true;
}

export async function neonProjectExists(id: string): Promise<boolean> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = await sql`SELECT 1 FROM projects WHERE id = ${id} LIMIT 1`;
  return rows.length > 0;
}

export async function neonUserHasProjectAccess(
  id: string,
  userId?: string | null,
  orgId?: string | null,
  clerkId?: string | null
): Promise<boolean> {
  await ensureNeonSchema();
  const sql = getSql();
  // No identity means no access; never fall back to "project exists".
  if (!userId && !orgId && !clerkId) return false;
  const rows = await sql`
    SELECT 1 FROM projects
    WHERE id = ${id} AND (
      (${userId || null}::varchar IS NOT NULL AND user_id = ${userId || null}) OR
      (${clerkId || null}::varchar IS NOT NULL AND user_id = ${clerkId || null}) OR
      (${orgId || null}::varchar IS NOT NULL AND organization_id = ${orgId || null})
    )
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function neonCreateProject(
  id: string,
  title: string,
  userId?: string | null,
  organizationId?: string | null
): Promise<ResearchProject> {
  await ensureNeonSchema();
  const sql = getSql();
  const createdAt = Date.now();
  await sql`
    INSERT INTO projects (id, title, user_id, organization_id, created_at)
    VALUES (${id}, ${title}, ${userId || null}, ${organizationId || null}, ${createdAt})
  `;

  return { id, title, userId: userId || null, organizationId: organizationId || null, createdAt };
}

// ============================================================================
// Nodes
// ============================================================================

interface RawNeonNode {
  id: string;
  project_id: string;
  type: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  color: string | null;
  title: string;
  content: string | null;
  items: string | null;
  image_url: string | null;
  caption: string | null;
  url: string | null;
  domain: string | null;
  description: string | null;
  section_id: string | null;
  file_data: string | null;
  file_name: string | null;
  file_size: number | null;
  file_type: string | null;
  page_count: number | null;
  metadata: string | null;
  created_at: number | string;
}

function mapNeonNode(row: RawNeonNode): CanvasNode {
  return {
    id: row.id,
    type: row.type as CanvasNodeType,
    x: Number(row.x),
    y: Number(row.y),
    width: row.width != null ? Number(row.width) : undefined,
    height: row.height != null ? Number(row.height) : undefined,
    color: (row.color as AccentColor) ?? 'neutral',
    title: row.title || (row.type === 'section' ? 'Untitled cluster' : 'Untitled record'),
    content: row.content ?? undefined,
    items: row.items ? (typeof row.items === 'string' ? JSON.parse(row.items) : row.items) : undefined,
    imageUrl: row.image_url ?? undefined,
    caption: row.caption ?? undefined,
    url: row.url ?? undefined,
    domain: row.domain ?? undefined,
    description: row.description ?? undefined,
    sectionId: row.section_id ?? undefined,
    fileData: row.file_data ?? undefined,
    fileName: row.file_name ?? undefined,
    fileSize: row.file_size != null ? Number(row.file_size) : undefined,
    fileType: row.file_type ?? undefined,
    pageCount: row.page_count != null ? Number(row.page_count) : undefined,
    metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : undefined,
    createdAt: Number(row.created_at)
  };
}

export async function neonGetAllNodes(projectId = 'default'): Promise<CanvasNode[]> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT * FROM nodes
    WHERE project_id = ${projectId}
    ORDER BY created_at ASC
  `) as unknown as RawNeonNode[];

  return rows.map(mapNeonNode);
}

type Sql = ReturnType<typeof getSql>;

export async function neonSaveNode(node: CanvasNode, projectId = 'default'): Promise<void> {
  await ensureNeonSchema();
  await nodeUpsert(getSql(), node, projectId);
}

/** Unawaited upsert, so it can also run inside a `sql.transaction([...])` batch. */
function nodeUpsert(sql: Sql, node: CanvasNode, projectId: string) {
  return sql`
    INSERT INTO nodes (
      id, project_id, type, x, y, width, height, color, title, content, items,
      image_url, caption, url, domain, description, section_id, file_data, file_name, file_size, file_type, page_count, metadata, created_at
    ) VALUES (
      ${node.id},
      ${projectId},
      ${node.type},
      ${node.x},
      ${node.y},
      ${node.width ?? null},
      ${node.height ?? null},
      ${node.color ?? 'neutral'},
      ${node.title},
      ${node.content ?? null},
      ${node.items ? JSON.stringify(node.items) : null},
      ${node.imageUrl ?? null},
      ${node.caption ?? null},
      ${node.url ?? null},
      ${node.domain ?? null},
      ${node.description ?? null},
      ${node.sectionId ?? null},
      ${node.fileData ?? null},
      ${node.fileName ?? null},
      ${node.fileSize ?? null},
      ${node.fileType ?? null},
      ${node.pageCount ?? null},
      ${node.metadata ? JSON.stringify(node.metadata) : null},
      ${node.createdAt}
    )
    ON CONFLICT (project_id, id) DO UPDATE SET
      type = EXCLUDED.type,
      x = EXCLUDED.x,
      y = EXCLUDED.y,
      width = EXCLUDED.width,
      height = EXCLUDED.height,
      color = EXCLUDED.color,
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      items = EXCLUDED.items,
      image_url = EXCLUDED.image_url,
      caption = EXCLUDED.caption,
      url = EXCLUDED.url,
      domain = EXCLUDED.domain,
      description = EXCLUDED.description,
      section_id = EXCLUDED.section_id,
      file_data = EXCLUDED.file_data,
      file_name = EXCLUDED.file_name,
      file_size = EXCLUDED.file_size,
      file_type = EXCLUDED.file_type,
      page_count = EXCLUDED.page_count,
      metadata = EXCLUDED.metadata
  `;
}

// ============================================================================
// Connections
// ============================================================================

interface RawNeonConnection {
  id: string;
  project_id: string;
  from_node: string;
  to_node: string;
  label: string | null;
  arrowhead: string | null;
  line_style: string | null;
  stroke_pattern: string | null;
  color: string | null;
  animated: boolean | null;
  metadata: string | null;
}

function mapNeonConnection(row: RawNeonConnection): Connection {
  return {
    id: row.id,
    from: row.from_node,
    to: row.to_node,
    label: row.label ?? undefined,
    arrowhead: (row.arrowhead as ArrowheadType) ?? 'end',
    lineStyle: (row.line_style as ConnectionLineStyle) ?? 'curved',
    strokePattern: (row.stroke_pattern as ConnectionStrokePattern) ?? 'dashed',
    color: (row.color as ConnectionColor) ?? 'indigo',
    animated: row.animated != null ? Boolean(row.animated) : true,
    metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : undefined
  };
}

export async function neonGetAllConnections(projectId = 'default'): Promise<Connection[]> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT * FROM connections
    WHERE project_id = ${projectId}
  `) as unknown as RawNeonConnection[];

  return rows.map(mapNeonConnection);
}

export async function neonSaveConnection(conn: Connection, projectId = 'default'): Promise<void> {
  await ensureNeonSchema();
  await connectionUpsert(getSql(), conn, projectId);
}

/** Unawaited upsert, so it can also run inside a `sql.transaction([...])` batch. */
function connectionUpsert(sql: Sql, conn: Connection, projectId: string) {
  return sql`
    INSERT INTO connections (
      id, project_id, from_node, to_node, label, arrowhead, line_style, stroke_pattern, color, animated, metadata, created_at
    ) VALUES (
      ${conn.id},
      ${projectId},
      ${conn.from},
      ${conn.to},
      ${conn.label ?? null},
      ${conn.arrowhead ?? 'end'},
      ${conn.lineStyle ?? 'curved'},
      ${conn.strokePattern ?? 'dashed'},
      ${conn.color ?? 'indigo'},
      ${conn.animated !== undefined ? conn.animated : true},
      ${conn.metadata ? JSON.stringify(conn.metadata) : null},
      ${Date.now()}
    )
    ON CONFLICT (project_id, id) DO UPDATE SET
      from_node = EXCLUDED.from_node,
      to_node = EXCLUDED.to_node,
      label = EXCLUDED.label,
      arrowhead = EXCLUDED.arrowhead,
      line_style = EXCLUDED.line_style,
      stroke_pattern = EXCLUDED.stroke_pattern,
      color = EXCLUDED.color,
      animated = EXCLUDED.animated,
      metadata = EXCLUDED.metadata
  `;
}

export async function neonGetGraphVersion(projectId: string): Promise<number> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = await sql`SELECT graph_version FROM projects WHERE id = ${projectId}`;
  return Number(rows[0]?.graph_version ?? 0);
}

export async function neonBulkSaveCanvas(
  nodes: CanvasNode[],
  connections: Connection[],
  projectId = 'default',
  baseVersion?: number
): Promise<SaveResult> {
  await ensureNeonSchema();
  const sql = getSql();

  // ponytail: the whole save is one HTTP transaction (guarded bump, deletes, every insert), so its size is
  // bounded only by the route caps (5,000 nodes / 15,000 links). Chunk into a COPY or staging table if that grows.
  // Guard and bump are ONE statement: under READ COMMITTED a concurrent save holding the row lock makes this UPDATE
  // re-check `graph_version = base` after it commits, so two saves from the same base can't both win. When the UPDATE
  // matches nothing, `1 / 0` raises division_by_zero (22012) and rolls the whole batch back.
  const base = baseVersion ?? null;
  try {
    const [bumped] = await sql.transaction([
      sql`
        WITH bumped AS (
          UPDATE projects SET graph_version = graph_version + 1
          WHERE id = ${projectId} AND (${base}::int IS NULL OR graph_version = ${base}::int)
          RETURNING graph_version
        )
        SELECT (SELECT graph_version FROM bumped) AS graph_version, 1 / (SELECT count(*)::int FROM bumped) AS ok
      `,
      sql`DELETE FROM nodes WHERE project_id = ${projectId}`,
      sql`DELETE FROM connections WHERE project_id = ${projectId}`,
      ...nodes.map(node => nodeUpsert(sql, node, projectId)),
      ...connections.map(conn => connectionUpsert(sql, conn, projectId))
    ]);
    return { saved: true, version: Number((bumped as Array<{ graph_version: number | string }>)[0].graph_version) };
  } catch (error) {
    if (baseVersion !== undefined && (error as { code?: string })?.code === '22012') {
      return { saved: false, version: await neonGetGraphVersion(projectId) };
    }
    throw error;
  }
}

// ============================================================================
// Research Sessions
// ============================================================================

interface RawNeonSession {
  id: string;
  project_id: string;
  query: string;
  mode: ResearchSession['mode'];
  status: ResearchSession['status'];
  summary: string;
  trail: string;
  changes: string;
  created_at: number | string;
}

function mapNeonSession(row: RawNeonSession): ResearchSession {
  return {
    id: row.id,
    query: row.query,
    mode: row.mode,
    status: row.status,
    summary: row.summary,
    trail: typeof row.trail === 'string' ? JSON.parse(row.trail) : row.trail,
    changes: typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes,
    createdAt: Number(row.created_at)
  };
}

export async function neonGetResearchSessions(projectId = 'default'): Promise<ResearchSession[]> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT * FROM research_sessions
    WHERE project_id = ${projectId}
    ORDER BY created_at DESC
    LIMIT 30
  `) as unknown as RawNeonSession[];

  return rows.map(mapNeonSession);
}

export async function neonGetResearchSession(id: string, projectId = 'default'): Promise<ResearchSession | undefined> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT * FROM research_sessions
    WHERE id = ${id} AND project_id = ${projectId}
    LIMIT 1
  `) as unknown as RawNeonSession[];

  return rows.length > 0 ? mapNeonSession(rows[0]) : undefined;
}

export async function neonSaveResearchSession(session: ResearchSession, projectId = 'default'): Promise<void> {
  await ensureNeonSchema();
  const sql = getSql();
  await sql`
    INSERT INTO research_sessions (id, project_id, query, mode, status, summary, trail, changes, created_at)
    VALUES (
      ${session.id},
      ${projectId},
      ${session.query},
      ${session.mode},
      ${session.status},
      ${session.summary},
      ${JSON.stringify(session.trail)},
      ${JSON.stringify(session.changes)},
      ${session.createdAt}
    )
  `;
}

export async function neonReviewResearchSession(
  id: string,
  decisions: Array<{ changeId: string; status: Exclude<ResearchChangeStatus, 'pending'> }>,
  projectId = 'default'
): Promise<ResearchSession | undefined> {
  await ensureNeonSchema();
  const session = await neonGetResearchSession(id, projectId);
  if (!session) return undefined;

  const decisionById = new Map(decisions.map(item => [item.changeId, item.status]));
  let changes = session.changes.map(change => ({
    ...change,
    status: change.status === 'pending' ? (decisionById.get(change.id) || change.status) : change.status
  }));
  const newlyReviewed = (change: ResearchSession['changes'][number]) => session.changes.find(item => item.id === change.id)?.status === 'pending';

  const [existingNodes, existingConns] = await Promise.all([
    neonGetAllNodes(projectId),
    neonGetAllConnections(projectId)
  ]);
  let graph = normalizeGraph(existingNodes, existingConns);

  const acceptedNodes = changes.filter(change => change.kind === 'node' && change.status === 'accepted' && newlyReviewed(change));
  for (const change of acceptedNodes) {
    graph = addNode(graph, change.payload as CanvasNode);
  }
  const acceptedNodeIds = new Set(Object.keys(graph.nodesById));
  changes = changes.map(change => {
    if (change.kind !== 'relationship' || change.status !== 'accepted' || !newlyReviewed(change)) return change;
    const edge = change.payload as Connection;
    return acceptedNodeIds.has(edge.from) && acceptedNodeIds.has(edge.to)
      ? change
      : { ...change, status: 'rejected', rationale: 'The relationship endpoint was not accepted.' };
  });

  const accepted = changes.filter(change => change.status === 'accepted' && newlyReviewed(change));
  for (const change of accepted.filter(item => item.kind === 'relationship')) {
    graph = addRelationship(graph, change.payload as Connection);
  }

  const updated: ResearchSession = {
    ...session,
    status: changes.some(change => change.status === 'pending') ? 'review' : 'complete',
    changes
  };

  // Commit accepted nodes and connections, the version bump and the session status together.
  const sql = getSql();
  await sql.transaction([
    ...accepted.filter(item => item.kind === 'node').map(item => nodeUpsert(sql, item.payload as CanvasNode, projectId)),
    ...accepted.filter(item => item.kind === 'relationship').map(item => connectionUpsert(sql, item.payload as Connection, projectId)),
    ...(accepted.length ? [sql`UPDATE projects SET graph_version = graph_version + 1 WHERE id = ${projectId}`] : []),
    sql`
      UPDATE research_sessions
      SET status = ${updated.status}, changes = ${JSON.stringify(updated.changes)}
      WHERE id = ${id} AND project_id = ${projectId}
    `
  ]);

  return updated;
}

// ============================================================================
// Graph Revisions
// ============================================================================

interface RawNeonRevision {
  id: string;
  project_id: string;
  title: string;
  node_count: number;
  edge_count: number;
  graph_data: string;
  created_at: number | string;
}

export async function neonCreateGraphRevision(
  projectId: string,
  title: string,
  nodes: CanvasNode[],
  relationships: Connection[]
): Promise<GraphRevisionSummary> {
  await ensureNeonSchema();
  const sql = getSql();
  const id = `rev-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const createdAt = Date.now();
  const nodeCount = nodes.length;
  const edgeCount = relationships.length;
  const graphData = JSON.stringify({ nodes, relationships });

  const record: GraphRevisionSummary = {
    id,
    projectId,
    title: title.trim() || 'Snapshot checkpoint',
    nodeCount,
    edgeCount,
    createdAt
  };

  await sql`
    INSERT INTO graph_revisions (id, project_id, title, node_count, edge_count, graph_data, created_at)
    VALUES (${id}, ${projectId}, ${record.title}, ${nodeCount}, ${edgeCount}, ${graphData}, ${createdAt})
  `;

  // Prune revisions beyond last 100
  await sql`
    DELETE FROM graph_revisions
    WHERE project_id = ${projectId} AND id NOT IN (
      SELECT id FROM graph_revisions WHERE project_id = ${projectId} ORDER BY created_at DESC LIMIT 100
    )
  `;

  return record;
}

export async function neonGetGraphRevisions(projectId: string, limit = 50): Promise<GraphRevisionSummary[]> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT id, project_id, title, node_count, edge_count, created_at
    FROM graph_revisions
    WHERE project_id = ${projectId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as unknown as RawNeonRevision[];

  return rows.map(r => ({
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    nodeCount: Number(r.node_count),
    edgeCount: Number(r.edge_count),
    createdAt: Number(r.created_at)
  }));
}

export async function neonGetGraphRevisionById(projectId: string, revisionId: string): Promise<GraphRevision | null> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT id, project_id, title, node_count, edge_count, graph_data, created_at
    FROM graph_revisions
    WHERE id = ${revisionId} AND project_id = ${projectId}
    LIMIT 1
  `) as unknown as RawNeonRevision[];

  if (rows.length === 0) return null;
  const row = rows[0];
  try {
    const parsed = typeof row.graph_data === 'string' ? JSON.parse(row.graph_data) : row.graph_data;
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      nodeCount: Number(row.node_count),
      edgeCount: Number(row.edge_count),
      createdAt: Number(row.created_at),
      nodes: parsed.nodes || [],
      relationships: parsed.relationships || []
    };
  } catch {
    return null;
  }
}

export async function neonRestoreGraphRevision(
  projectId: string,
  revisionId: string
): Promise<{ revision: GraphRevisionSummary; nodes: CanvasNode[]; relationships: Connection[] } | null> {
  const target = await neonGetGraphRevisionById(projectId, revisionId);
  if (!target) return null;

  await neonBulkSaveCanvas(target.nodes, target.relationships, projectId);
  const restoreCheckpoint = await neonCreateGraphRevision(
    projectId,
    `Restored: ${target.title}`,
    target.nodes,
    target.relationships
  );

  return {
    revision: restoreCheckpoint,
    nodes: target.nodes,
    relationships: target.relationships
  };
}

export async function neonDeleteGraphRevision(projectId: string, revisionId: string): Promise<boolean> {
  await ensureNeonSchema();
  const sql = getSql();
  const res = await sql`
    DELETE FROM graph_revisions WHERE id = ${revisionId} AND project_id = ${projectId} RETURNING id
  `;
  return res.length > 0;
}

// ============================================================================
// Multi-Tenant Users & Context Credits Ledger
// ============================================================================

interface RawNeonUser {
  id: string;
  clerk_id: string;
  email: string | null;
  name: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_tier: UserRecord['subscriptionTier'];
  subscription_status: UserRecord['subscriptionStatus'];
  seat_count: number | null;
  billing_interval: UserRecord['billingInterval'];
  current_period_end: number | string | null;
  context_credits: number | string;
  trial_ends_at: number | string | null;
  created_at: number | string;
}

function mapNeonUser(row: RawNeonUser): UserRecord {
  return {
    id: row.id,
    clerkId: row.clerk_id,
    email: row.email,
    name: row.name,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    subscriptionTier: row.subscription_tier,
    subscriptionStatus: row.subscription_status,
    seatCount: row.seat_count != null ? Number(row.seat_count) : 1,
    billingInterval: row.billing_interval || 'month',
    currentPeriodEnd: row.current_period_end != null ? Number(row.current_period_end) : null,
    contextCredits: Number(row.context_credits || 0),
    trialEndsAt: row.trial_ends_at != null ? Number(row.trial_ends_at) : null,
    createdAt: Number(row.created_at)
  };
}

export async function neonGetUserById(id: string): Promise<UserRecord | null> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM users WHERE id = ${id} LIMIT 1`) as unknown as RawNeonUser[];
  return rows.length > 0 ? mapNeonUser(rows[0]) : null;
}

export async function neonGetUserByClerkId(clerkId: string): Promise<UserRecord | null> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM users WHERE clerk_id = ${clerkId} LIMIT 1`) as unknown as RawNeonUser[];
  return rows.length > 0 ? mapNeonUser(rows[0]) : null;
}

export async function neonGetUserByStripeCustomerId(stripeCustomerId: string): Promise<UserRecord | null> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM users WHERE stripe_customer_id = ${stripeCustomerId} LIMIT 1`) as unknown as RawNeonUser[];
  return rows.length > 0 ? mapNeonUser(rows[0]) : null;
}

export async function neonGetUserByStripeSubscriptionId(stripeSubscriptionId: string): Promise<UserRecord | null> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM users WHERE stripe_subscription_id = ${stripeSubscriptionId} LIMIT 1`) as unknown as RawNeonUser[];
  return rows.length > 0 ? mapNeonUser(rows[0]) : null;
}

export async function neonUpdateUserSubscription(userId: string, data: Partial<UserRecord>): Promise<UserRecord | null> {
  await ensureNeonSchema();
  const existing = await neonGetUserById(userId);
  if (!existing) return null;

  const updated: UserRecord = {
    ...existing,
    ...data,
    id: existing.id
  };

  const sql = getSql();
  await sql`
    UPDATE users SET
      stripe_customer_id = ${updated.stripeCustomerId || null},
      stripe_subscription_id = ${updated.stripeSubscriptionId || null},
      subscription_tier = ${updated.subscriptionTier},
      subscription_status = ${updated.subscriptionStatus},
      seat_count = ${updated.seatCount || 1},
      billing_interval = ${updated.billingInterval || 'month'},
      current_period_end = ${updated.currentPeriodEnd || null},
      context_credits = ${updated.contextCredits},
      trial_ends_at = ${updated.trialEndsAt || null}
    WHERE id = ${userId}
  `;

  return updated;
}

export async function neonUpsertUser(user: Partial<UserRecord> & { clerkId: string }): Promise<UserRecord> {
  await ensureNeonSchema();
  const existing = await neonGetUserByClerkId(user.clerkId);
  const now = Date.now();
  const sql = getSql();

  if (existing) {
    const next: UserRecord = {
      ...existing,
      ...user,
      id: existing.id,
      clerkId: user.clerkId,
      createdAt: existing.createdAt
    };

    await sql`
      UPDATE users SET
        email = ${next.email},
        name = ${next.name},
        stripe_customer_id = ${next.stripeCustomerId},
        stripe_subscription_id = ${next.stripeSubscriptionId || null},
        subscription_tier = ${next.subscriptionTier},
        subscription_status = ${next.subscriptionStatus},
        seat_count = ${next.seatCount || 1},
        billing_interval = ${next.billingInterval || 'month'},
        current_period_end = ${next.currentPeriodEnd || null},
        context_credits = ${next.contextCredits},
        trial_ends_at = ${next.trialEndsAt}
      WHERE clerk_id = ${next.clerkId}
    `;

    return next;
  }

  const id = `usr-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 10)}`;
  const trialEnds = user.trialEndsAt !== undefined ? user.trialEndsAt : null;
  const newUser: UserRecord = {
    id,
    clerkId: user.clerkId,
    email: user.email || null,
    name: user.name || null,
    stripeCustomerId: user.stripeCustomerId || null,
    stripeSubscriptionId: user.stripeSubscriptionId || null,
    subscriptionTier: user.subscriptionTier || 'none',
    subscriptionStatus: user.subscriptionStatus || 'unselected',
    seatCount: user.seatCount || 1,
    billingInterval: user.billingInterval || 'month',
    currentPeriodEnd: user.currentPeriodEnd || null,
    contextCredits: typeof user.contextCredits === 'number' ? user.contextCredits : 0,
    trialEndsAt: trialEnds,
    createdAt: now
  };

  await sql`
    INSERT INTO users (
      id, clerk_id, email, name, stripe_customer_id, stripe_subscription_id,
      subscription_tier, subscription_status, seat_count, billing_interval,
      current_period_end, context_credits, trial_ends_at, created_at
    ) VALUES (
      ${newUser.id}, ${newUser.clerkId}, ${newUser.email}, ${newUser.name},
      ${newUser.stripeCustomerId}, ${newUser.stripeSubscriptionId},
      ${newUser.subscriptionTier}, ${newUser.subscriptionStatus},
      ${newUser.seatCount}, ${newUser.billingInterval},
      ${newUser.currentPeriodEnd}, ${newUser.contextCredits},
      ${newUser.trialEndsAt}, ${newUser.createdAt}
    )
  `;

  return newUser;
}

export async function neonDeductUserCredits(
  userIdentifier: string,
  amount: number,
  action: CreditTransaction['action'],
  metadata?: string
): Promise<{ success: boolean; balance: number; error?: string }> {
  await ensureNeonSchema();
  const user = (await neonGetUserByClerkId(userIdentifier)) || (await neonGetUserById(userIdentifier));
  if (!user) {
    return { success: false, balance: 0, error: 'User account not found.' };
  }

  const txId = `ctx-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  const sql = getSql();

  // Check and decrement in one statement so concurrent requests can't overspend.
  const rows = (await sql`
    UPDATE users SET context_credits = context_credits - ${amount}
    WHERE id = ${user.id} AND context_credits >= ${amount}
    RETURNING context_credits
  `) as unknown as Array<{ context_credits: number | string }>;
  if (rows.length === 0) {
    return {
      success: false,
      balance: user.contextCredits,
      error: `Insufficient Context Credits (${user.contextCredits} available, ${amount} required). Please refill your credits.`
    };
  }
  const nextBalance = Number(rows[0].context_credits);

  await sql`
    INSERT INTO credit_transactions (id, user_id, amount, action, balance_after, metadata, created_at)
    VALUES (${txId}, ${user.id}, ${-amount}, ${action}, ${nextBalance}, ${metadata || null}, ${now})
  `;

  return { success: true, balance: nextBalance };
}

export async function neonTopUpUserCredits(
  userIdentifier: string,
  amount: number,
  action: CreditTransaction['action'] = 'refill',
  metadata?: string
): Promise<{ success: boolean; balance: number }> {
  await ensureNeonSchema();
  let user = (await neonGetUserByClerkId(userIdentifier)) || (await neonGetUserById(userIdentifier));
  if (!user) {
    user = await neonUpsertUser({ clerkId: userIdentifier });
  }

  const nextBalance = user.contextCredits + amount;
  const txId = `ctx-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  const sql = getSql();

  await sql`UPDATE users SET context_credits = ${nextBalance} WHERE id = ${user.id}`;
  await sql`
    INSERT INTO credit_transactions (id, user_id, amount, action, balance_after, metadata, created_at)
    VALUES (${txId}, ${user.id}, ${amount}, ${action}, ${nextBalance}, ${metadata || null}, ${now})
  `;

  return { success: true, balance: nextBalance };
}

export async function neonGetCreditTransactions(userId: string, limit = 50): Promise<CreditTransaction[]> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT id, user_id as "userId", amount, action, balance_after as "balanceAfter", metadata, created_at as "createdAt"
    FROM credit_transactions
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  return rows.map(r => ({
    id: String(r.id),
    userId: String(r.userId),
    amount: Number(r.amount),
    action: String(r.action),
    balanceAfter: Number(r.balanceAfter),
    metadata: r.metadata ? String(r.metadata) : null,
    createdAt: Number(r.createdAt)
  }));
}

function parseNeonJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export async function neonGetChatMessages(projectId: string, userKey: string, threadId: string, limit = 50): Promise<ChatMessageRecord[]> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM chat_messages
    WHERE project_id = ${projectId} AND user_key = ${userKey} AND thread_id = ${threadId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `;
  return rows.reverse().map(r => ({
    id: String(r.id),
    projectId: String(r.project_id),
    threadId: String(r.thread_id),
    userKey: String(r.user_key),
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: String(r.content),
    referencedNodeIds: parseNeonJson<string[]>(r.referenced_node_ids, []),
    toolCall: parseNeonJson<unknown>(r.tool_call, null),
    provider: r.provider ? String(r.provider) : null,
    model: r.model ? String(r.model) : null,
    createdAt: Number(r.created_at)
  }));
}

export async function neonGetLatestChatThreadId(projectId: string, userKey: string): Promise<string | null> {
  await ensureNeonSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT thread_id FROM chat_messages
    WHERE project_id = ${projectId} AND user_key = ${userKey}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows.length > 0 ? String(rows[0].thread_id) : null;
}

export async function neonSaveChatMessages(messages: ChatMessageRecord[]): Promise<void> {
  if (messages.length === 0) return;
  await ensureNeonSchema();
  const sql = getSql();
  await sql.transaction(messages.map(m => sql`
    INSERT INTO chat_messages (id, project_id, thread_id, user_key, role, content, referenced_node_ids, tool_call, provider, model, created_at)
    VALUES (
      ${m.id}, ${m.projectId}, ${m.threadId}, ${m.userKey}, ${m.role}, ${m.content},
      ${JSON.stringify(m.referencedNodeIds)}, ${m.toolCall == null ? null : JSON.stringify(m.toolCall)},
      ${m.provider ?? null}, ${m.model ?? null}, ${m.createdAt}
    )
  `));
}
