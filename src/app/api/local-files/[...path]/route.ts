import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { LOCAL_FILE_TYPES, resolveLocalFile } from '@/lib/local-files';

// Serves files from SYNTHEX_UPLOAD_DIR in desktop builds only.
export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> }
) {
  const notFound = () => NextResponse.json({ error: 'Not found.' }, { status: 404 });
  const root = process.env.SYNTHEX_UPLOAD_DIR;
  if (process.env.SYNTHEX_DESKTOP !== '1' || !root) return notFound();

  const { path: segments } = await context.params;
  // Segments are already URL-decoded.
  const target = resolveLocalFile(root, segments);
  if (!target) return notFound();

  try {
    if (!(await fs.promises.stat(target)).isFile()) return notFound();
  } catch {
    return notFound();
  }

  // SVG can carry scripts, so never let it execute as a document.
  const stream = Readable.toWeb(fs.createReadStream(target)) as ReadableStream;
  return new Response(stream, {
    headers: {
      'Content-Type': LOCAL_FILE_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
    },
  });
}
