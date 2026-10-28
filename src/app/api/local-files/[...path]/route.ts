import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

// Serves files from SYNTHEX_UPLOAD_DIR in desktop builds only.
export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> }
) {
  const notFound = () => NextResponse.json({ error: 'Not found.' }, { status: 404 });
  const root = process.env.SYNTHEX_UPLOAD_DIR;
  if (process.env.SYNTHEX_DESKTOP !== '1' || !root) return notFound();

  const { path: segments } = await context.params;
  // Segments are already URL-decoded, so reject separators, drive letters and NULs inside them.
  if (segments.some((s) => !s || s === '..' || /[\/:\0]/.test(s))) return notFound();

  const base = path.resolve(root);
  const target = path.resolve(base, ...segments);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return notFound();

  try {
    if (!(await fs.promises.stat(target)).isFile()) return notFound();
  } catch {
    return notFound();
  }

  // SVG can carry scripts, so never let it execute as a document.
  const stream = Readable.toWeb(fs.createReadStream(target)) as ReadableStream;
  return new Response(stream, {
    headers: {
      'Content-Type': CONTENT_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    },
  });
}
