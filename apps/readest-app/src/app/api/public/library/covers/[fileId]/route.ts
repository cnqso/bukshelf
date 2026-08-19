import { NextResponse } from 'next/server';
import { getPublicCoverFileKey, isPublicLibraryEnabled } from '@/libs/publicLibraryServer';
import { getObject } from '@/utils/object';

interface RouteParams {
  params: Promise<{ fileId: string }>;
}

const FILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const detectImageContentType = (body: Uint8Array): string | null => {
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47) {
    return 'image/png';
  }
  if (
    String.fromCharCode(...body.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...body.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  const signature = String.fromCharCode(...body.slice(0, 6));
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  return null;
};

export async function GET(_request: Request, { params }: RouteParams) {
  if (!isPublicLibraryEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { fileId } = await params;
  if (!FILE_ID_PATTERN.test(fileId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const fileKey = await getPublicCoverFileKey(fileId);
    if (!fileKey) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const object = await getObject(fileKey);
    const contentType = detectImageContentType(object.body);
    if (!contentType) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const responseBody = new ArrayBuffer(object.body.byteLength);
    new Uint8Array(responseBody).set(object.body);

    return new NextResponse(responseBody, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': object.body.byteLength.toString(),
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[public-library] cover failed', { fileId, error });
    return NextResponse.json({ error: 'Could not load cover' }, { status: 500 });
  }
}
