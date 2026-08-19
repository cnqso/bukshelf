import { NextResponse } from 'next/server';
import { getPublicLibraryBooks, isPublicLibraryEnabled } from '@/libs/publicLibraryServer';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isPublicLibraryEnabled()) {
    return NextResponse.json({ error: 'Public library is disabled' }, { status: 404 });
  }

  try {
    const books = await getPublicLibraryBooks();
    return NextResponse.json(
      { books },
      {
        headers: {
          'Cache-Control': 'public, max-age=30, stale-while-revalidate=120',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    );
  } catch (error) {
    console.error('[public-library] list failed', error);
    return NextResponse.json({ error: 'Could not load the library' }, { status: 500 });
  }
}
