import path from 'path';

// Desktop builds keep uploads in SYNTHEX_UPLOAD_DIR, served at /api/local-files/{projectId}/{fileName}.
export const LOCAL_FILES_PREFIX = '/api/local-files/';

export const LOCAL_FILE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

/** The absolute path of a file under `root`, or null when the (already URL-decoded) segments could leave it. */
export function resolveLocalFile(root: string, segments: string[]): string | null {
  // Reject separators, drive letters and NULs inside segments.
  if (!segments.length || segments.some((s) => !s || s === '..' || /[\/\:\0]/.test(s))) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, ...segments);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}
