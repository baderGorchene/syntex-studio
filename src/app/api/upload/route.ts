import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { getServerAuth } from '@/lib/auth';
import { userHasProjectAccess } from '@/lib/db';

// Max file upload limit: 50MB
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const rawProjectId = formData.get('projectId');

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json({ error: 'No valid file provided for upload.' }, { status: 400 });
    }

    if (file.size > MAX_UPLOAD_SIZE) {
      return NextResponse.json(
        { error: `File exceeds maximum allowed size of 50MB (${Math.round(file.size / 1024 / 1024)}MB uploaded).` },
        { status: 413 }
      );
    }

    const auth = await getServerAuth();
    const userId = auth.user?.id || auth.userId;
    if (!auth.isLocal && !userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Sanitize projectId to prevent path traversal
    const projectId = typeof rawProjectId === 'string'
      ? rawProjectId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'default'
      : 'default';
    if (!(await userHasProjectAccess(projectId, userId, auth.orgId, auth.clerkId, auth.isDevice))) {
      return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
    }

    // Get original filename and safe extension
    const rawName = 'name' in file && typeof file.name === 'string' ? file.name : 'upload';
    const parsed = path.parse(rawName);
    const safeExt = parsed.ext.toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 16);
    const baseSlug = parsed.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 60) || 'file';

    // Unique filename: timestamp + random suffix + safe extension
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fileName = `${baseSlug}-${uniqueSuffix}${safeExt}`;
    const fileType = safeExt.replace('.', '') || file.type.split('/')[1] || 'bin';

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 1. If Google Cloud Storage (GCS) is configured, upload to cloud vault
    const { isGcsConfigured, uploadBufferToGcs } = await import('@/lib/storage-gcs');
    if (isGcsConfigured()) {
      try {
        const gcsDestination = `workspaces/${projectId}/${fileName}`;
        const gcsResult = await uploadBufferToGcs(buffer, gcsDestination, file.type || 'application/octet-stream');
        return NextResponse.json({
          url: gcsResult.url,
          fileName: rawName,
          fileSize: file.size,
          fileType,
          mimeType: file.type,
          storage: 'gcs',
          gcsPath: gcsResult.gcsPath
        });
      } catch (gcsErr) {
        console.warn('GCS upload attempt failed, falling back to serverless-safe storage:', gcsErr);
      }
    }

    // 2. Check if running in a Serverless environment (Vercel / AWS Lambda)
    // Serverless runtimes have a read-only filesystem (no writable /public directory)
    const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

    if (!isServerless) {
      try {
        // Local disk storage for non-serverless local development (public/uploads/{projectId}),
        // or SYNTHEX_UPLOAD_DIR/{projectId} for desktop builds (served by /api/local-files)
        const customDir = process.env.SYNTHEX_UPLOAD_DIR;
        const uploadsDir = customDir
          ? path.join(customDir, projectId)
          : path.join(process.cwd(), 'public', 'uploads', projectId);
        await fs.mkdir(uploadsDir, { recursive: true });

        const targetFilePath = path.join(uploadsDir, fileName);
        await fs.writeFile(targetFilePath, buffer);

        const relativeUrl = customDir
          ? `/api/local-files/${projectId}/${fileName}`
          : `/uploads/${projectId}/${fileName}`;

        return NextResponse.json({
          url: relativeUrl,
          fileName: rawName,
          fileSize: file.size,
          fileType,
          mimeType: file.type,
          storage: 'local'
        });
      } catch (diskErr) {
        console.warn('Local disk write failed, falling back to inline Data URI:', diskErr);
      }
    }

    // 3. Serverless / Resilient Fallback: Inline Base64 Data URI
    // Eliminates ENOENT / EROFS filesystem crashes on Vercel when GCS is unconfigured
    const mime = file.type || (fileType === 'pdf' ? 'application/pdf' : 'application/octet-stream');
    const base64Data = buffer.toString('base64');
    const dataUrl = `data:${mime};base64,${base64Data}`;

    return NextResponse.json({
      url: dataUrl,
      fileName: rawName,
      fileSize: file.size,
      fileType,
      mimeType: file.type,
      storage: 'inline'
    });
  } catch (error) {
    console.error('File upload error:', error);
    return NextResponse.json(
      { error: 'Failed to save file to server storage.' },
      { status: 500 }
    );
  }
}
