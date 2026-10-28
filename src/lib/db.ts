import type Database from 'better-sqlite3';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import type {
  AccentColor,
  ArrowheadType,
  CanvasNode,
  CanvasNodeType,
  Connection,
  ConnectionColor,
  ConnectionLineStyle,
  ConnectionStrokePattern,
  DatabaseSnapshotSummary,
  GraphRevision,
  GraphRevisionSummary,
  ResearchChangeStatus,
  ResearchSession
} from '../types/canvas';
import { addNode, addRelationship, normalizeGraph } from './graph.ts';
import {
  isNeonConfigured,
  neonGetProjects,
  neonMoveProjectToWorkspace,
  neonRenameProject,
  neonDeleteProject,
  neonProjectExists,
  neonUserHasProjectAccess,
  neonCreateProject,
  neonGetAllNodes,
  neonSaveNode,
  neonGetAllConnections,
  neonSaveConnection,
  neonBulkSaveCanvas,
  neonGetGraphVersion,
  neonGetResearchSessions,
  neonGetResearchSession,
  neonSaveResearchSession,
  neonReviewResearchSession,
  neonCreateGraphRevision,
  neonGetGraphRevisions,
  neonGetGraphRevisionById,
  neonRestoreGraphRevision,
  neonDeleteGraphRevision,
  neonGetUserById,
  neonGetUserByClerkId,
  neonGetUserByStripeCustomerId,
  neonGetUserByStripeSubscriptionId,
  neonUpdateUserSubscription,
  neonUpsertUser,
  neonDeductUserCredits,
  neonTopUpUserCredits,
  neonGetCreditTransactions,
  neonGetChatMessages,
  neonGetLatestChatThreadId,
  neonSaveChatMessages
} from './neon.ts';

const require = createRequire(import.meta.url);
// Lazily load better-sqlite3 so Vercel serverless environments using Neon never touch native addons
let BetterSqlite3Constructor: (new (path: string) => Database.Database) | null = null;
function getBetterSqlite3() {
  if (!BetterSqlite3Constructor) {
    BetterSqlite3Constructor = require('better-sqlite3') as new (path: string) => Database.Database;
  }
  return BetterSqlite3Constructor;
}

function getDbPath(): string {
  // Desktop builds keep the database in a per-user data directory.
  if (process.env.SYNTHEX_DATA_DIR) {
    fs.mkdirSync(process.env.SYNTHEX_DATA_DIR, { recursive: true });
    return path.join(process.env.SYNTHEX_DATA_DIR, 'canvas.db');
  }
  // On Vercel / AWS Lambda, the app root is read-only (EROFS).
  // /tmp is the only writable directory available to serverless functions.
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const tmpDbPath = path.join('/tmp', 'canvas.db');
    const sourceDbPath = path.join(process.cwd(), 'canvas.db');
    if (!fs.existsSync(tmpDbPath) && fs.existsSync(sourceDbPath)) {
      try {
        fs.copyFileSync(sourceDbPath, tmpDbPath);
      } catch (err) {
        console.warn('Could not copy seed database to /tmp:', err);
      }
    }
    return tmpDbPath;
  }
  return path.join(process.cwd(), 'canvas.db');
}

interface DbNodeRow {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  color: string | null;
  title: string;
  content: string | null;
  items: string | null;
  imageUrl: string | null;
  caption: string | null;
  url: string | null;
  domain: string | null;
  description: string | null;
  sectionId?: string | null;
  fileData?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  fileType?: string | null;
  pageCount?: number | null;
  metadata: string | null;
  createdAt: number;
}

interface DbConnectionRow {
  id: string;
  from_node: string;
  to_node: string;
  label: string | null;
  arrowhead: string | null;
  line_style: string | null;
  stroke_pattern: string | null;
  color: string | null;
  animated: number | null;
  metadata: string | null;
}

// Global cache for Next.js development hot-reloading
declare global {
  var _sqliteDb: Database.Database | undefined;
}

function ensureSchemaColumns(db: Database.Database) {
  // Graph chat memory: one thread per user per project at a time, newest thread wins.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      threadId TEXT NOT NULL,
      userKey TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      referencedNodeIds TEXT NOT NULL DEFAULT '[]',
      toolCall TEXT,
      provider TEXT,
      model TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_messages_thread_idx ON chat_messages(projectId, userKey, threadId, createdAt);
  `);

  const nodeColumns = [
    { name: 'metadata', type: 'TEXT' },
    { name: 'projectId', type: "TEXT NOT NULL DEFAULT 'default'" },
    { name: 'sectionId', type: 'TEXT' },
    { name: 'fileData', type: 'TEXT' },
    { name: 'fileName', type: 'TEXT' },
    { name: 'fileSize', type: 'INTEGER' },
    { name: 'fileType', type: 'TEXT' },
    { name: 'pageCount', type: 'INTEGER' },
    { name: 'userId', type: 'TEXT' },
    { name: 'organizationId', type: 'TEXT' }
  ];
  for (const col of nodeColumns) {
    try {
      db.exec(`ALTER TABLE nodes ADD COLUMN ${col.name} ${col.type}`);
    } catch {
      // Column already exists.
    }
  }

  const connColumns = [
    { name: 'arrowhead', type: 'TEXT' },
    { name: 'line_style', type: 'TEXT' },
    { name: 'stroke_pattern', type: 'TEXT' },
    { name: 'color', type: 'TEXT' },
    { name: 'animated', type: 'INTEGER' },
    { name: 'metadata', type: 'TEXT' },
    { name: 'projectId', type: "TEXT NOT NULL DEFAULT 'default'" },
    { name: 'userId', type: 'TEXT' },
    { name: 'organizationId', type: 'TEXT' }
  ];
  for (const col of connColumns) {
    try {
      db.exec(`ALTER TABLE connections ADD COLUMN ${col.name} ${col.type}`);
    } catch {
      // Column already exists, safe to ignore
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS research_sessions (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL DEFAULT 'default',
      query TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      trail TEXT NOT NULL,
      changes TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);
  const sessionColumns = [
    { name: 'projectId', type: "TEXT NOT NULL DEFAULT 'default'" },
    { name: 'userId', type: 'TEXT' },
    { name: 'organizationId', type: 'TEXT' }
  ];
  for (const col of sessionColumns) {
    try {
      db.exec(`ALTER TABLE research_sessions ADD COLUMN ${col.name} ${col.type}`);
    } catch {
      // Column already exists.
    }
  }

  migrateProjectScopedIds(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
  `);
  const projectColumns = [
    { name: 'userId', type: 'TEXT' },
    { name: 'organizationId', type: 'TEXT' },
    { name: 'graphVersion', type: 'INTEGER NOT NULL DEFAULT 0' }
  ];
  for (const col of projectColumns) {
    try {
      db.exec(`ALTER TABLE projects ADD COLUMN ${col.name} ${col.type}`);
    } catch {
      // Column already exists
    }
  }

  const userCols = [
    { name: 'stripeSubscriptionId', type: 'TEXT' },
    { name: 'seatCount', type: 'INTEGER DEFAULT 1' },
    { name: 'currentPeriodEnd', type: 'INTEGER' },
    { name: 'billingInterval', type: "TEXT DEFAULT 'month'" }
  ];
  for (const col of userCols) {
    try {
      db.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
    } catch {
      // Column already exists
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS nodes_project_idx ON nodes(projectId);
    CREATE INDEX IF NOT EXISTS connections_project_idx ON connections(projectId);
    CREATE INDEX IF NOT EXISTS research_project_idx ON research_sessions(projectId, createdAt);
    INSERT OR IGNORE INTO projects (id, title, createdAt) VALUES ('default', 'Research workspace', 1761000000000);

    CREATE TABLE IF NOT EXISTS graph_revisions (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL DEFAULT 'default',
      title TEXT NOT NULL,
      nodeCount INTEGER NOT NULL,
      edgeCount INTEGER NOT NULL,
      graphData TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS graph_revisions_project_idx ON graph_revisions(projectId, createdAt DESC);

    -- Multi-tenant user identity & billing accounts
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      clerkId TEXT UNIQUE NOT NULL,
      email TEXT,
      name TEXT,
      stripeCustomerId TEXT UNIQUE,
      stripeSubscriptionId TEXT,
      subscriptionTier TEXT NOT NULL DEFAULT 'trial',
      subscriptionStatus TEXT NOT NULL DEFAULT 'active',
      seatCount INTEGER DEFAULT 1,
      billingInterval TEXT DEFAULT 'month',
      currentPeriodEnd INTEGER,
      contextCredits INTEGER NOT NULL DEFAULT 100,
      trialEndsAt INTEGER,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS users_clerk_idx ON users(clerkId);
    CREATE INDEX IF NOT EXISTS users_stripe_idx ON users(stripeCustomerId);

    -- Context credits deduction & refill ledger
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      amount INTEGER NOT NULL,
      action TEXT NOT NULL,
      balanceAfter INTEGER NOT NULL,
      metadata TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS credit_tx_user_idx ON credit_transactions(userId, createdAt DESC);
  `);
}

function migrateProjectScopedIds(db: Database.Database) {
  const nodePrimaryKey = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string; pk: number }>;
  if (nodePrimaryKey.filter(column => column.pk > 0).length < 2) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE nodes_scoped (
          id TEXT NOT NULL, projectId TEXT NOT NULL DEFAULT 'default', type TEXT NOT NULL,
          x REAL NOT NULL, y REAL NOT NULL, width REAL, height REAL, color TEXT,
          title TEXT NOT NULL, content TEXT, items TEXT, imageUrl TEXT, caption TEXT,
          url TEXT, domain TEXT, description TEXT, metadata TEXT, createdAt INTEGER NOT NULL,
          PRIMARY KEY (projectId, id)
        );
        INSERT INTO nodes_scoped (id, projectId, type, x, y, width, height, color, title, content, items, imageUrl, caption, url, domain, description, metadata, createdAt)
          SELECT id, projectId, type, x, y, width, height, color, title, content, items, imageUrl, caption, url, domain, description, metadata, createdAt FROM nodes;
        DROP TABLE nodes;
        ALTER TABLE nodes_scoped RENAME TO nodes;
      `);
    })();
  }

  const connectionPrimaryKey = db.prepare('PRAGMA table_info(connections)').all() as Array<{ name: string; pk: number }>;
  if (connectionPrimaryKey.filter(column => column.pk > 0).length < 2) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE connections_scoped (
          id TEXT NOT NULL, projectId TEXT NOT NULL DEFAULT 'default', from_node TEXT NOT NULL,
          to_node TEXT NOT NULL, label TEXT, arrowhead TEXT, line_style TEXT,
          stroke_pattern TEXT, color TEXT, animated INTEGER, metadata TEXT,
          PRIMARY KEY (projectId, id)
        );
        INSERT INTO connections_scoped (id, projectId, from_node, to_node, label, arrowhead, line_style, stroke_pattern, color, animated, metadata)
          SELECT id, projectId, from_node, to_node, label, arrowhead, line_style, stroke_pattern, color, animated, metadata FROM connections;
        DROP TABLE connections;
        ALTER TABLE connections_scoped RENAME TO connections;
      `);
    })();
  }
}

export function getDatabase(): Database.Database {
  if (!global._sqliteDb) {
    const SqliteClass = getBetterSqlite3();
    const activePath = getDbPath();
    global._sqliteDb = new SqliteClass(activePath);
    initSchema(global._sqliteDb);
  } else {
    ensureSchemaColumns(global._sqliteDb);
  }

  return global._sqliteDb;
}

export const getDb = getDatabase;

function initSchema(db: Database.Database) {
  // Enable WAL mode for concurrent performance
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT NOT NULL,
      projectId TEXT NOT NULL DEFAULT 'default',
      type TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      width REAL,
      height REAL,
      color TEXT,
      title TEXT NOT NULL,
      content TEXT,
      items TEXT,
      imageUrl TEXT,
      caption TEXT,
      url TEXT,
      domain TEXT,
      description TEXT,
      metadata TEXT,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (projectId, id)
    );

    CREATE TABLE IF NOT EXISTS connections (
      id TEXT NOT NULL,
      projectId TEXT NOT NULL DEFAULT 'default',
      from_node TEXT NOT NULL,
      to_node TEXT NOT NULL,
      label TEXT,
      arrowhead TEXT,
      line_style TEXT,
      stroke_pattern TEXT,
      color TEXT,
      animated INTEGER,
      metadata TEXT,
      PRIMARY KEY (projectId, id)
    );

    CREATE TABLE IF NOT EXISTS research_sessions (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL DEFAULT 'default',
      query TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      trail TEXT NOT NULL,
      changes TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
  `);

  ensureSchemaColumns(db);
}

export function getAllNodesFromDb(projectId = 'default'): CanvasNode[] | Promise<CanvasNode[]> {
  if (isNeonConfigured()) {
    return neonGetAllNodes(projectId);
  }
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM nodes WHERE projectId = ? ORDER BY createdAt ASC').all(projectId) as DbNodeRow[];

  return rows.map(row => ({
    id: row.id,
    type: row.type as CanvasNodeType,
    x: row.x,
    y: row.y,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    color: (row.color as AccentColor) ?? 'neutral',
    title: row.title || (row.type === 'section' ? 'Untitled cluster' : 'Untitled record'),
    content: row.content ?? undefined,
    items: row.items ? JSON.parse(row.items) : undefined,
    imageUrl: row.imageUrl ?? undefined,
    caption: row.caption ?? undefined,
    url: row.url ?? undefined,
    domain: row.domain ?? undefined,
    description: row.description ?? undefined,
    sectionId: row.sectionId ?? undefined,
    fileData: row.fileData ?? undefined,
    fileName: row.fileName ?? undefined,
    fileSize: row.fileSize ?? undefined,
    fileType: row.fileType ?? undefined,
    pageCount: row.pageCount ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.createdAt
  }));
}

export function saveNodeToDb(node: CanvasNode, projectId = 'default'): void | Promise<void> {
  if (isNeonConfigured()) {
    return neonSaveNode(node, projectId);
  }
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO nodes (
      id, projectId, type, x, y, width, height, color, title, content, items,
      imageUrl, caption, url, domain, description, sectionId, fileData, fileName, fileSize, fileType, pageCount, metadata, createdAt
    ) VALUES (
      @id, @projectId, @type, @x, @y, @width, @height, @color, @title, @content, @items,
      @imageUrl, @caption, @url, @domain, @description, @sectionId, @fileData, @fileName, @fileSize, @fileType, @pageCount, @metadata, @createdAt
    )
    ON CONFLICT(projectId, id) DO UPDATE SET
      type = excluded.type,
      x = excluded.x,
      y = excluded.y,
      width = excluded.width,
      height = excluded.height,
      color = excluded.color,
      title = excluded.title,
      content = excluded.content,
      items = excluded.items,
      imageUrl = excluded.imageUrl,
      caption = excluded.caption,
      url = excluded.url,
      domain = excluded.domain,
      description = excluded.description,
      sectionId = excluded.sectionId,
      fileData = excluded.fileData,
      fileName = excluded.fileName,
      fileSize = excluded.fileSize,
      fileType = excluded.fileType,
      pageCount = excluded.pageCount,
      metadata = excluded.metadata
  `);

  stmt.run({
    id: node.id,
    projectId,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width ?? null,
    height: node.height ?? null,
    color: node.color ?? 'neutral',
    title: node.title,
    content: node.content ?? null,
    items: node.items ? JSON.stringify(node.items) : null,
    imageUrl: node.imageUrl ?? null,
    caption: node.caption ?? null,
    url: node.url ?? null,
    domain: node.domain ?? null,
    description: node.description ?? null,
    sectionId: node.sectionId ?? null,
    fileData: node.fileData ?? null,
    fileName: node.fileName ?? null,
    fileSize: node.fileSize ?? null,
    fileType: node.fileType ?? null,
    pageCount: node.pageCount ?? null,
    metadata: node.metadata ? JSON.stringify(node.metadata) : null,
    createdAt: node.createdAt
  });
}

export function getAllConnectionsFromDb(projectId = 'default'): Connection[] | Promise<Connection[]> {
  if (isNeonConfigured()) {
    return neonGetAllConnections(projectId);
  }
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM connections WHERE projectId = ?').all(projectId) as DbConnectionRow[];

  return rows.map(row => ({
    id: row.id,
    from: row.from_node,
    to: row.to_node,
    label: row.label ?? undefined,
    arrowhead: (row.arrowhead as ArrowheadType) ?? 'end',
    lineStyle: (row.line_style as ConnectionLineStyle) ?? 'curved',
    strokePattern: (row.stroke_pattern as ConnectionStrokePattern) ?? 'dashed',
    color: (row.color as ConnectionColor) ?? 'indigo',
    animated: row.animated !== null ? Boolean(row.animated) : true,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined
  }));
}

export function saveConnectionToDb(conn: Connection, projectId = 'default'): void | Promise<void> {
  if (isNeonConfigured()) {
    return neonSaveConnection(conn, projectId);
  }
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO connections (id, projectId, from_node, to_node, label, arrowhead, line_style, stroke_pattern, color, animated, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(projectId, id) DO UPDATE SET
      from_node = excluded.from_node,
      to_node = excluded.to_node,
      label = excluded.label,
      arrowhead = excluded.arrowhead,
      line_style = excluded.line_style,
      stroke_pattern = excluded.stroke_pattern,
      color = excluded.color,
      animated = excluded.animated,
      metadata = excluded.metadata
  `);

  stmt.run(
    conn.id,
    projectId,
    conn.from,
    conn.to,
    conn.label ?? null,
    conn.arrowhead ?? 'end',
    conn.lineStyle ?? 'curved',
    conn.strokePattern ?? 'dashed',
    conn.color ?? 'indigo',
    conn.animated !== undefined ? (conn.animated ? 1 : 0) : 1,
    conn.metadata ? JSON.stringify(conn.metadata) : null
  );
}

export type SaveResult = { saved: true; version: number } | { saved: false; version: number };

function readGraphVersion(db: Database.Database, projectId: string): number {
  const row = db.prepare('SELECT graphVersion FROM projects WHERE id = ?').get(projectId) as { graphVersion: number } | undefined;
  return row?.graphVersion ?? 0;
}

function bumpGraphVersion(db: Database.Database, projectId: string): number {
  db.prepare('UPDATE projects SET graphVersion = graphVersion + 1 WHERE id = ?').run(projectId);
  return readGraphVersion(db, projectId);
}

export function getGraphVersion(projectId: string): number | Promise<number> {
  if (isNeonConfigured()) {
    return neonGetGraphVersion(projectId);
  }
  return readGraphVersion(getDatabase(), projectId);
}

/** Replaces the project's graph and bumps its version. With `baseVersion`, refuses (writes nothing) if the map moved on. */
export function bulkSaveCanvasToDb(nodes: CanvasNode[], connections: Connection[], projectId = 'default', baseVersion?: number): SaveResult | Promise<SaveResult> {
  if (isNeonConfigured()) {
    return neonBulkSaveCanvas(nodes, connections, projectId, baseVersion);
  }
  const db = getDatabase();
  const sync = db.transaction((): SaveResult => {
    const current = readGraphVersion(db, projectId);
    if (baseVersion !== undefined && baseVersion !== current) return { saved: false, version: current };

    db.prepare('DELETE FROM nodes WHERE projectId = ?').run(projectId);
    db.prepare('DELETE FROM connections WHERE projectId = ?').run(projectId);

    for (const node of nodes) {
      saveNodeToDb(node, projectId);
    }
    for (const conn of connections) {
      saveConnectionToDb(conn, projectId);
    }
    return { saved: true, version: bumpGraphVersion(db, projectId) };
  });

  return sync();
}

interface DbResearchSessionRow {
  id: string;
  projectId: string;
  query: string;
  mode: ResearchSession['mode'];
  status: ResearchSession['status'];
  summary: string;
  trail: string;
  changes: string;
  createdAt: number;
}

function mapResearchSession(row: DbResearchSessionRow): ResearchSession {
  return {
    ...row,
    trail: JSON.parse(row.trail),
    changes: JSON.parse(row.changes)
  };
}

export function getResearchSessions(projectId = 'default'): ResearchSession[] | Promise<ResearchSession[]> {
  if (isNeonConfigured()) {
    return neonGetResearchSessions(projectId);
  }
  const rows = getDatabase()
    .prepare('SELECT * FROM research_sessions WHERE projectId = ? ORDER BY createdAt DESC LIMIT 30')
    .all(projectId) as DbResearchSessionRow[];
  return rows.map(mapResearchSession);
}

export function getResearchSession(id: string, projectId = 'default'): ResearchSession | undefined | Promise<ResearchSession | undefined> {
  if (isNeonConfigured()) {
    return neonGetResearchSession(id, projectId);
  }
  const row = getDatabase().prepare('SELECT * FROM research_sessions WHERE id = ? AND projectId = ?').get(id, projectId) as DbResearchSessionRow | undefined;
  return row ? mapResearchSession(row) : undefined;
}

export function saveResearchSession(session: ResearchSession, projectId = 'default'): void | Promise<void> {
  if (isNeonConfigured()) {
    return neonSaveResearchSession(session, projectId);
  }
  getDatabase().prepare(`
    INSERT INTO research_sessions (id, projectId, query, mode, status, summary, trail, changes, createdAt)
    VALUES (@id, @projectId, @query, @mode, @status, @summary, @trail, @changes, @createdAt)
  `).run({
    ...session,
    projectId,
    trail: JSON.stringify(session.trail),
    changes: JSON.stringify(session.changes)
  });
}

export function reviewResearchSession(
  id: string,
  decisions: Array<{ changeId: string; status: Exclude<ResearchChangeStatus, 'pending'> }>,
  projectId = 'default'
): ResearchSession | undefined | Promise<ResearchSession | undefined> {
  if (isNeonConfigured()) {
    return neonReviewResearchSession(id, decisions, projectId);
  }
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM research_sessions WHERE id = ? AND projectId = ?').get(id, projectId) as DbResearchSessionRow | undefined;
  if (!row) return undefined;
  const session = mapResearchSession(row);
  const decisionById = new Map(decisions.map(item => [item.changeId, item.status]));
  let changes = session.changes.map(change => ({
    ...change,
    status: change.status === 'pending' ? (decisionById.get(change.id) || change.status) : change.status
  }));
  const newlyReviewed = (change: ResearchSession['changes'][number]) => session.changes.find(item => item.id === change.id)?.status === 'pending';

  let graph = normalizeGraph(getAllNodesFromDb(projectId) as CanvasNode[], getAllConnectionsFromDb(projectId) as Connection[]);
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
  const commit = db.transaction(() => {
    for (const change of accepted.filter(item => item.kind === 'node')) saveNodeToDb(change.payload as CanvasNode, projectId);
    for (const change of accepted.filter(item => item.kind === 'relationship')) saveConnectionToDb(change.payload as Connection, projectId);
    if (accepted.length) bumpGraphVersion(db, projectId);
    db.prepare(`
      UPDATE research_sessions SET status = @status, changes = @changes WHERE id = @id AND projectId = @projectId
    `).run({ id, projectId, status: updated.status, changes: JSON.stringify(updated.changes) });
  });
  commit();
  return updated;
}

export interface ResearchProject {
  id: string;
  title: string;
  createdAt: number;
  userId?: string | null;
  organizationId?: string | null;
}

/**
 * Maps in the active workspace. With a team (org) active: the team's maps only. Without one: the user's
 * personal maps only (never maps they created inside a team), so switching workspace switches the list.
 */
export function getProjectsFromDb(
  userId?: string | null,
  orgId?: string | null,
  clerkId?: string | null
): ResearchProject[] | Promise<ResearchProject[]> {
  if (isNeonConfigured()) {
    return neonGetProjects(userId, orgId, clerkId);
  }
  const db = getDatabase();
  if (orgId) {
    return db.prepare(`
      SELECT id, title, createdAt, userId, organizationId
      FROM projects
      WHERE organizationId = ?
      ORDER BY createdAt ASC
    `).all(orgId) as ResearchProject[];
  }
  const owners = [userId, clerkId].filter((value): value is string => Boolean(value));
  if (!owners.length) return [];
  return db.prepare(`
    SELECT id, title, createdAt, userId, organizationId
    FROM projects
    WHERE organizationId IS NULL AND userId IN (${owners.map(() => '?').join(', ')})
    ORDER BY createdAt ASC
  `).all(...owners) as ResearchProject[];
}

/**
 * Moves a map the user created between their personal workspace (orgId null) and a team.
 * Only the map's creator may move it. Returns false when the map isn't theirs.
 */
export function moveProjectToWorkspace(
  id: string,
  orgId: string | null,
  userId?: string | null,
  clerkId?: string | null
): boolean | Promise<boolean> {
  if (isNeonConfigured()) {
    return neonMoveProjectToWorkspace(id, orgId, userId, clerkId);
  }
  const owners = [userId, clerkId].filter((value): value is string => Boolean(value));
  if (!owners.length) return false;
  const result = getDatabase().prepare(`
    UPDATE projects SET organizationId = ?
    WHERE id = ? AND userId IN (${owners.map(() => '?').join(', ')})
  `).run(orgId, id, ...owners);
  return result.changes > 0;
}

/** Renames a map. The caller checks the user can open it (userHasProjectAccess) first. */
export function renameProjectInDb(id: string, title: string): boolean | Promise<boolean> {
  if (isNeonConfigured()) {
    return neonRenameProject(id, title);
  }
  return getDatabase().prepare('UPDATE projects SET title = ? WHERE id = ?').run(title, id).changes > 0;
}

/**
 * Deletes a map and everything scoped to it (notes, links, research, revisions, chat).
 * Only the map's creator may delete it. Returns false when the map isn't theirs.
 */
export function deleteProjectFromDb(
  id: string,
  userId?: string | null,
  clerkId?: string | null
): boolean | Promise<boolean> {
  if (isNeonConfigured()) {
    return neonDeleteProject(id, userId, clerkId);
  }
  const owners = [userId, clerkId].filter((value): value is string => Boolean(value));
  if (!owners.length) return false;
  const db = getDatabase();
  const owned = db.prepare(`SELECT 1 FROM projects WHERE id = ? AND userId IN (${owners.map(() => '?').join(', ')})`).get(id, ...owners);
  if (!owned) return false;
  db.transaction(() => {
    for (const table of ['connections', 'nodes', 'research_sessions', 'graph_revisions', 'chat_messages']) {
      db.prepare(`DELETE FROM ${table} WHERE projectId = ?`).run(id);
    }
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  })();
  return true;
}

export function projectExistsInDb(id: string): boolean | Promise<boolean> {
  if (isNeonConfigured()) {
    return neonProjectExists(id);
  }
  return Boolean(getDatabase().prepare('SELECT 1 FROM projects WHERE id = ?').get(id));
}

export function userHasProjectAccess(
  id: string,
  userId?: string | null,
  orgId?: string | null,
  clerkId?: string | null
): boolean | Promise<boolean> {
  if (isNeonConfigured()) {
    return neonUserHasProjectAccess(id, userId, orgId, clerkId);
  }
  const db = getDatabase();
  // No identity means no access; never fall back to "project exists".
  if (!userId && !orgId && !clerkId) return false;
  const conditions: string[] = [];
  const params: string[] = [id];
  if (userId) {
    conditions.push('userId = ?');
    params.push(userId);
  }
  if (clerkId) {
    conditions.push('userId = ?');
    params.push(clerkId);
  }
  if (orgId) {
    conditions.push('organizationId = ?');
    params.push(orgId);
  }
  const row = db.prepare(`
    SELECT 1 FROM projects
    WHERE id = ? AND (${conditions.join(' OR ')})
  `).get(...params);
  return Boolean(row);
}

export function createProjectInDb(
  id: string,
  title: string,
  userId?: string | null,
  organizationId?: string | null
): ResearchProject | Promise<ResearchProject> {
  if (isNeonConfigured()) {
    return neonCreateProject(id, title, userId, organizationId);
  }
  const project: ResearchProject = {
    id,
    title,
    createdAt: Date.now(),
    userId: userId || null,
    organizationId: organizationId || null
  };
  getDatabase().prepare(`
    INSERT INTO projects (id, title, createdAt, userId, organizationId)
    VALUES (@id, @title, @createdAt, @userId, @organizationId)
  `).run(project);
  return project;
}

export function createGraphRevision(
  projectId: string,
  title: string,
  nodes: CanvasNode[],
  relationships: Connection[]
): GraphRevisionSummary | Promise<GraphRevisionSummary> {
  if (isNeonConfigured()) {
    return neonCreateGraphRevision(projectId, title, nodes, relationships);
  }
  const db = getDatabase();
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

  db.transaction(() => {
    db.prepare(`
      INSERT INTO graph_revisions (id, projectId, title, nodeCount, edgeCount, graphData, createdAt)
      VALUES (@id, @projectId, @title, @nodeCount, @edgeCount, @graphData, @createdAt)
    `).run({ ...record, graphData });

    // Prune revisions beyond the last 100 per project
    db.prepare(`
      DELETE FROM graph_revisions
      WHERE projectId = ? AND id NOT IN (
        SELECT id FROM graph_revisions WHERE projectId = ? ORDER BY createdAt DESC LIMIT 100
      )
    `).run(projectId, projectId);
  })();

  return record;
}

export function getGraphRevisions(projectId: string, limit = 50): GraphRevisionSummary[] | Promise<GraphRevisionSummary[]> {
  if (isNeonConfigured()) {
    return neonGetGraphRevisions(projectId, limit);
  }
  const db = getDatabase();
  return db.prepare(`
    SELECT id, projectId, title, nodeCount, edgeCount, createdAt
    FROM graph_revisions
    WHERE projectId = ?
    ORDER BY createdAt DESC
    LIMIT ?
  `).all(projectId, limit) as GraphRevisionSummary[];
}

export function getGraphRevisionById(projectId: string, revisionId: string): GraphRevision | null | Promise<GraphRevision | null> {
  if (isNeonConfigured()) {
    return neonGetGraphRevisionById(projectId, revisionId);
  }
  const db = getDatabase();
  const row = db.prepare(`
    SELECT id, projectId, title, nodeCount, edgeCount, graphData, createdAt
    FROM graph_revisions
    WHERE id = ? AND projectId = ?
  `).get(revisionId, projectId) as (GraphRevisionSummary & { graphData: string }) | undefined;

  if (!row) return null;

  try {
    const parsed = JSON.parse(row.graphData);
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      nodeCount: row.nodeCount,
      edgeCount: row.edgeCount,
      createdAt: row.createdAt,
      nodes: parsed.nodes || [],
      relationships: parsed.relationships || []
    };
  } catch {
    return null;
  }
}

export function restoreGraphRevision(
  projectId: string,
  revisionId: string
): { revision: GraphRevisionSummary; nodes: CanvasNode[]; relationships: Connection[] } | null | Promise<{ revision: GraphRevisionSummary; nodes: CanvasNode[]; relationships: Connection[] } | null> {
  if (isNeonConfigured()) {
    return neonRestoreGraphRevision(projectId, revisionId);
  }
  const target = getGraphRevisionById(projectId, revisionId) as GraphRevision | null;
  if (!target) return null;

  // Atomically save the target graph to the database and record a restoration checkpoint
  bulkSaveCanvasToDb(target.nodes, target.relationships, projectId);
  const restoreCheckpoint = createGraphRevision(
    projectId,
    `Restored: ${target.title}`,
    target.nodes,
    target.relationships
  ) as GraphRevisionSummary;

  return {
    revision: restoreCheckpoint,
    nodes: target.nodes,
    relationships: target.relationships
  };
}

export function deleteGraphRevision(projectId: string, revisionId: string): boolean | Promise<boolean> {
  if (isNeonConfigured()) {
    return neonDeleteGraphRevision(projectId, revisionId);
  }
  const db = getDatabase();
  const result = db.prepare('DELETE FROM graph_revisions WHERE id = ? AND projectId = ?').run(revisionId, projectId);
  return result.changes > 0;
}

// --------------------------------------------------------------------------
// Database-level Full Snapshots & Rollback
// --------------------------------------------------------------------------

const BACKUP_DIR = path.join(process.cwd(), '.backups');

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

export function getDatabaseFilePath(): string {
  return getDbPath();
}

export function getBackupFilePath(fileName: string): string | null {
  ensureBackupDir();
  const safeName = path.basename(fileName);
  if (!safeName.endsWith('.db')) return null;
  const target = path.join(BACKUP_DIR, safeName);
  return fs.existsSync(target) ? target : null;
}

export async function createDatabaseBackup(label?: string): Promise<DatabaseSnapshotSummary> {
  ensureBackupDir();
  const db = getDatabase();

  // Flush WAL changes before backup
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch {
    // Continue even if checkpoint fails
  }

  let projectCount = 0;
  let nodeCount = 0;
  let edgeCount = 0;
  try {
    const pRow = db.prepare('SELECT count(*) as count FROM projects').get() as { count: number } | undefined;
    projectCount = pRow?.count || 0;
    const nRow = db.prepare('SELECT count(*) as count FROM nodes').get() as { count: number } | undefined;
    nodeCount = nRow?.count || 0;
    const eRow = db.prepare('SELECT count(*) as count FROM connections').get() as { count: number } | undefined;
    edgeCount = eRow?.count || 0;
  } catch {
    // ignore
  }

  const now = Date.now();
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  const id = `snap_${now}_${randomSuffix}`;
  const fileName = `${id}.db`;
  const destPath = path.join(BACKUP_DIR, fileName);

  await db.backup(destPath);

  const stats = fs.statSync(destPath);
  const summary: DatabaseSnapshotSummary = {
    id,
    fileName,
    label: label?.trim() || `Workspace Snapshot (${new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`,
    sizeBytes: stats.size,
    projectCount,
    nodeCount,
    edgeCount,
    createdAt: now
  };

  const metaPath = path.join(BACKUP_DIR, `${id}.meta.json`);
  fs.writeFileSync(metaPath, JSON.stringify(summary, null, 2), 'utf-8');

  return summary;
}

export function getDatabaseBackups(): DatabaseSnapshotSummary[] {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR);
  const snapshots: DatabaseSnapshotSummary[] = [];

  for (const file of files) {
    if (!file.endsWith('.db')) continue;
    const dbFilePath = path.join(BACKUP_DIR, file);
    const metaPath = path.join(BACKUP_DIR, file.replace(/\.db$/, '.meta.json'));

    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as DatabaseSnapshotSummary;
        snapshots.push(meta);
        continue;
      } catch {
        // Fall back to reading file stats
      }
    }

    try {
      const stats = fs.statSync(dbFilePath);
      const id = file.replace(/\.db$/, '');
      snapshots.push({
        id,
        fileName: file,
        label: `Snapshot ${file}`,
        sizeBytes: stats.size,
        projectCount: 1,
        nodeCount: 0,
        edgeCount: 0,
        createdAt: stats.mtimeMs
      });
    } catch {
      // ignore
    }
  }

  return snapshots.sort((a, b) => b.createdAt - a.createdAt);
}

export async function restoreDatabaseBackup(
  fileName: string
): Promise<{ success: boolean; snapshot: DatabaseSnapshotSummary }> {
  ensureBackupDir();
  const safeName = path.basename(fileName);
  const sourcePath = path.join(BACKUP_DIR, safeName);
  if (!fs.existsSync(sourcePath) || !safeName.endsWith('.db')) {
    throw new Error('Snapshot file not found.');
  }

  // 1. If DB is open, checkpoint and close it cleanly
  if (global._sqliteDb) {
    try {
      global._sqliteDb.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // ignore
    }
    try {
      global._sqliteDb.close();
    } catch {
      // ignore
    }
    global._sqliteDb = undefined;
  }

  // 2. Remove lingering WAL/SHM files for active database
  const activePath = getDbPath();
  const walPath = `${activePath}-wal`;
  const shmPath = `${activePath}-shm`;
  if (fs.existsSync(walPath)) {
    try { fs.unlinkSync(walPath); } catch {}
  }
  if (fs.existsSync(shmPath)) {
    try { fs.unlinkSync(shmPath); } catch {}
  }

  // 3. Copy snapshot over active database
  fs.copyFileSync(sourcePath, activePath);

  // 4. Re-open DB to verify and run schema migration if needed
  getDatabase();

  // 5. Read metadata
  const metaPath = path.join(BACKUP_DIR, safeName.replace(/\.db$/, '.meta.json'));
  let snapshot: DatabaseSnapshotSummary;
  if (fs.existsSync(metaPath)) {
    try {
      snapshot = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {
      snapshot = {
        id: safeName.replace(/\.db$/, ''),
        fileName: safeName,
        label: safeName,
        sizeBytes: fs.statSync(sourcePath).size,
        projectCount: 1,
        nodeCount: 0,
        edgeCount: 0,
        createdAt: Date.now()
      };
    }
  } else {
    snapshot = {
      id: safeName.replace(/\.db$/, ''),
      fileName: safeName,
      label: safeName,
      sizeBytes: fs.statSync(sourcePath).size,
      projectCount: 1,
      nodeCount: 0,
      edgeCount: 0,
      createdAt: Date.now()
    };
  }

  return { success: true, snapshot };
}

export function deleteDatabaseBackup(fileName: string): boolean {
  ensureBackupDir();
  const safeName = path.basename(fileName);
  if (!safeName.endsWith('.db')) return false;

  const dbFilePath = path.join(BACKUP_DIR, safeName);
  const metaFilePath = path.join(BACKUP_DIR, safeName.replace(/\.db$/, '.meta.json'));

  let deleted = false;
  if (fs.existsSync(dbFilePath)) {
    fs.unlinkSync(dbFilePath);
    deleted = true;
  }
  if (fs.existsSync(metaFilePath)) {
    try { fs.unlinkSync(metaFilePath); } catch {}
  }

  return deleted;
}

// ============================================================================
// Multi-Tenant Users & Context Credits Ledger
// ============================================================================

export interface UserRecord {
  id: string;
  clerkId: string;
  email: string | null;
  name: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionTier: 'none' | 'trial' | 'byok' | 'pro' | 'team';
  subscriptionStatus: 'unselected' | 'active' | 'past_due' | 'canceled' | 'trialing';
  seatCount?: number | null;
  billingInterval?: 'month' | 'year' | null;
  currentPeriodEnd?: number | null;
  contextCredits: number;
  trialEndsAt: number | null;
  createdAt: number;
}

export interface ChatMessageRecord {
  id: string;
  projectId: string;
  threadId: string;
  /** The signed-in user (or the local user); threads are private to them. */
  userKey: string;
  role: 'user' | 'assistant';
  content: string;
  referencedNodeIds: string[];
  toolCall: unknown | null;
  provider?: string | null;
  model?: string | null;
  createdAt: number;
}

type DbChatMessageRow = Omit<ChatMessageRecord, 'referencedNodeIds' | 'toolCall'> & { referencedNodeIds: string; toolCall: string | null };

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** The most recent messages of a thread, oldest first. */
export function getChatMessages(projectId: string, userKey: string, threadId: string, limit = 50): ChatMessageRecord[] | Promise<ChatMessageRecord[]> {
  if (isNeonConfigured()) {
    return neonGetChatMessages(projectId, userKey, threadId, limit);
  }
  const rows = getDatabase().prepare(`
    SELECT * FROM chat_messages
    WHERE projectId = ? AND userKey = ? AND threadId = ?
    ORDER BY createdAt DESC, rowid DESC
    LIMIT ?
  `).all(projectId, userKey, threadId, limit) as DbChatMessageRow[];
  return rows.reverse().map(row => ({
    ...row,
    referencedNodeIds: parseJson<string[]>(row.referencedNodeIds, []),
    toolCall: parseJson<unknown>(row.toolCall, null)
  }));
}

export function getLatestChatThreadId(projectId: string, userKey: string): string | null | Promise<string | null> {
  if (isNeonConfigured()) {
    return neonGetLatestChatThreadId(projectId, userKey);
  }
  const row = getDatabase().prepare(`
    SELECT threadId FROM chat_messages
    WHERE projectId = ? AND userKey = ?
    ORDER BY createdAt DESC, rowid DESC
    LIMIT 1
  `).get(projectId, userKey) as { threadId: string } | undefined;
  return row?.threadId ?? null;
}

export function saveChatMessages(messages: ChatMessageRecord[]): void | Promise<void> {
  if (isNeonConfigured()) {
    return neonSaveChatMessages(messages);
  }
  const db = getDatabase();
  const insert = db.prepare(`
    INSERT INTO chat_messages (id, projectId, threadId, userKey, role, content, referencedNodeIds, toolCall, provider, model, createdAt)
    VALUES (@id, @projectId, @threadId, @userKey, @role, @content, @referencedNodeIds, @toolCall, @provider, @model, @createdAt)
  `);
  db.transaction(() => {
    for (const message of messages) {
      insert.run({
        ...message,
        referencedNodeIds: JSON.stringify(message.referencedNodeIds),
        toolCall: message.toolCall == null ? null : JSON.stringify(message.toolCall),
        provider: message.provider ?? null,
        model: message.model ?? null
      });
    }
  })();
}

export interface CreditTransaction {
  id: string;
  userId: string;
  amount: number;
  action: 'chat' | 'quick_research' | 'deep_research' | 'pdf_extract' | 'refill' | 'bonus' | string;
  balanceAfter: number;
  metadata?: string | null;
  createdAt: number;
}

export function getUserById(id: string): UserRecord | null | Promise<UserRecord | null> {
  if (isNeonConfigured()) {
    return neonGetUserById(id);
  }
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRecord | undefined;
  return row || null;
}

export function getUserByClerkId(clerkId: string): UserRecord | null | Promise<UserRecord | null> {
  if (isNeonConfigured()) {
    return neonGetUserByClerkId(clerkId);
  }
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM users WHERE clerkId = ?').get(clerkId) as UserRecord | undefined;
  return row || null;
}

export function getUserByStripeCustomerId(stripeCustomerId: string): UserRecord | null | Promise<UserRecord | null> {
  if (isNeonConfigured()) {
    return neonGetUserByStripeCustomerId(stripeCustomerId);
  }
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM users WHERE stripeCustomerId = ?').get(stripeCustomerId) as UserRecord | undefined;
  return row || null;
}

export function getUserByStripeSubscriptionId(stripeSubscriptionId: string): UserRecord | null | Promise<UserRecord | null> {
  if (isNeonConfigured()) {
    return neonGetUserByStripeSubscriptionId(stripeSubscriptionId);
  }
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM users WHERE stripeSubscriptionId = ?').get(stripeSubscriptionId) as UserRecord | undefined;
  return row || null;
}

export function updateUserSubscription(
  userId: string,
  data: Partial<UserRecord>
): UserRecord | null | Promise<UserRecord | null> {
  if (isNeonConfigured()) {
    return neonUpdateUserSubscription(userId, data);
  }
  const db = getDatabase();
  const existing = getUserById(userId) as UserRecord | null;
  if (!existing) return null;

  const updated: UserRecord = {
    ...existing,
    ...data,
    id: existing.id
  };

  db.prepare(`
    UPDATE users SET
      stripeCustomerId = ?,
      stripeSubscriptionId = ?,
      subscriptionTier = ?,
      subscriptionStatus = ?,
      seatCount = ?,
      billingInterval = ?,
      currentPeriodEnd = ?,
      contextCredits = ?,
      trialEndsAt = ?
    WHERE id = ?
  `).run(
    updated.stripeCustomerId || null,
    updated.stripeSubscriptionId || null,
    updated.subscriptionTier,
    updated.subscriptionStatus,
    updated.seatCount || 1,
    updated.billingInterval || 'month',
    updated.currentPeriodEnd || null,
    updated.contextCredits,
    updated.trialEndsAt || null,
    userId
  );

  return updated;
}

export function upsertUser(user: Partial<UserRecord> & { clerkId: string }): UserRecord | Promise<UserRecord> {
  if (isNeonConfigured()) {
    return neonUpsertUser(user);
  }
  const db = getDatabase();
  const existing = getUserByClerkId(user.clerkId) as UserRecord | null;
  const now = Date.now();

  if (existing) {
    const next: UserRecord = {
      ...existing,
      ...user,
      id: existing.id,
      clerkId: user.clerkId,
      createdAt: existing.createdAt
    };
    db.prepare(`
      UPDATE users SET
        email = ?, name = ?, stripeCustomerId = ?, stripeSubscriptionId = ?,
        subscriptionTier = ?, subscriptionStatus = ?, seatCount = ?,
        billingInterval = ?, currentPeriodEnd = ?, contextCredits = ?, trialEndsAt = ?
      WHERE clerkId = ?
    `).run(
      next.email, next.name, next.stripeCustomerId, next.stripeSubscriptionId || null,
      next.subscriptionTier, next.subscriptionStatus, next.seatCount || 1,
      next.billingInterval || 'month', next.currentPeriodEnd || null,
      next.contextCredits, next.trialEndsAt,
      next.clerkId
    );
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

  db.prepare(`
    INSERT INTO users (id, clerkId, email, name, stripeCustomerId, stripeSubscriptionId, subscriptionTier, subscriptionStatus, seatCount, billingInterval, currentPeriodEnd, contextCredits, trialEndsAt, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newUser.id, newUser.clerkId, newUser.email, newUser.name,
    newUser.stripeCustomerId, newUser.stripeSubscriptionId,
    newUser.subscriptionTier, newUser.subscriptionStatus,
    newUser.seatCount, newUser.billingInterval, newUser.currentPeriodEnd,
    newUser.contextCredits, newUser.trialEndsAt, newUser.createdAt
  );

  return newUser;
}

export function deductUserCredits(
  userIdentifier: string,
  amount: number,
  action: CreditTransaction['action'],
  metadata?: string
): { success: boolean; balance: number; error?: string } | Promise<{ success: boolean; balance: number; error?: string }> {
  if (isNeonConfigured()) {
    return neonDeductUserCredits(userIdentifier, amount, action, metadata);
  }
  const db = getDatabase();
  const user = (getUserByClerkId(userIdentifier) || getUserById(userIdentifier)) as UserRecord | null;
  if (!user) {
    return { success: false, balance: 0, error: 'User account not found.' };
  }

  const txId = `ctx-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();

  // Check and decrement in one statement so concurrent requests can't overspend.
  const runTx = db.transaction(() => {
    const row = db.prepare(
      'UPDATE users SET contextCredits = contextCredits - ? WHERE id = ? AND contextCredits >= ? RETURNING contextCredits'
    ).get(amount, user.id, amount) as { contextCredits: number } | undefined;
    if (!row) return null;
    db.prepare(`
      INSERT INTO credit_transactions (id, userId, amount, action, balanceAfter, metadata, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(txId, user.id, -amount, action, row.contextCredits, metadata || null, now);
    return row.contextCredits;
  });

  const nextBalance = runTx();
  if (nextBalance === null) {
    return {
      success: false,
      balance: user.contextCredits,
      error: `Insufficient Context Credits (${user.contextCredits} available, ${amount} required). Please refill your credits.`
    };
  }

  return { success: true, balance: nextBalance };
}

export function topUpUserCredits(
  userIdentifier: string,
  amount: number,
  action: CreditTransaction['action'] = 'refill',
  metadata?: string
): { success: boolean; balance: number } | Promise<{ success: boolean; balance: number }> {
  if (isNeonConfigured()) {
    return neonTopUpUserCredits(userIdentifier, amount, action, metadata);
  }
  const db = getDatabase();
  let user = (getUserByClerkId(userIdentifier) || getUserById(userIdentifier)) as UserRecord | null;
  if (!user) {
    user = upsertUser({ clerkId: userIdentifier }) as UserRecord;
  }

  const nextBalance = user.contextCredits + amount;
  const txId = `ctx-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();

  const runTx = db.transaction(() => {
    db.prepare('UPDATE users SET contextCredits = ? WHERE id = ?').run(nextBalance, user.id);
    db.prepare(`
      INSERT INTO credit_transactions (id, userId, amount, action, balanceAfter, metadata, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(txId, user.id, amount, action, nextBalance, metadata || null, now);
  });

  runTx();

  return { success: true, balance: nextBalance };
}

export function getCreditTransactions(userId: string, limit = 50): CreditTransaction[] | Promise<CreditTransaction[]> {
  if (isNeonConfigured()) {
    return neonGetCreditTransactions(userId, limit);
  }
  const db = getDatabase();
  return db.prepare('SELECT * FROM credit_transactions WHERE userId = ? ORDER BY createdAt DESC LIMIT ?')
    .all(userId, limit) as CreditTransaction[];
}

