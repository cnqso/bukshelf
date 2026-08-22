// Server-side helpers for the two Next-owned share surfaces that render
// directly from the server (the `/s/[token]` landing page's metadata and its
// OG image) rather than being called from the browser. Every other share
// operation (create/list/revoke/download/import) is a Bun-owned API route —
// see apps/bukshelf-server/src/shareRoutes.ts — reached from the browser via
// bukshelfProviderUrl(), never through Next.
//
// These two run in the same unified process as Bun (unifiedServer.ts), so
// they reach it over loopback rather than the public origin: that avoids a
// dependency on SITE_URL/a reverse proxy being reachable from inside the
// container, and matches how Bun is already listening regardless of how the
// public origin is configured.

const internalBaseUrl = (): string => `http://127.0.0.1:${process.env['BUKSHELF_PORT'] ?? '43175'}`;

export interface ResolvedShare {
  bookTitle: string;
  bookAuthor: string | null;
  bookFormat: string;
  bookSize: number;
  expiresAt: string;
  hasCover: boolean;
  hasCfi: boolean;
  downloadCount: number;
}

export type ShareLookupRejection =
  | { kind: 'invalid_token' }
  | { kind: 'not_found' }
  | { kind: 'revoked' }
  | { kind: 'expired' }
  | { kind: 'source_deleted' }
  | { kind: 'lookup_failed'; detail?: string };

const REJECTION_BY_CODE: Record<string, ShareLookupRejection['kind']> = {
  invalid_token: 'invalid_token',
  not_found: 'not_found',
  revoked: 'revoked',
  expired: 'expired',
  source_deleted: 'source_deleted',
};

export const resolveActiveShare = async (
  rawToken: string,
): Promise<{ ok: true; share: ResolvedShare } | { ok: false; reason: ShareLookupRejection }> => {
  let response: Response;
  try {
    response = await fetch(`${internalBaseUrl()}/api/share/${encodeURIComponent(rawToken)}`, {
      cache: 'no-store',
    });
  } catch (err) {
    return {
      ok: false,
      reason: { kind: 'lookup_failed', detail: err instanceof Error ? err.message : String(err) },
    };
  }

  if (response.ok) {
    const share = (await response.json()) as ResolvedShare;
    return { ok: true, share };
  }

  const body = (await response.json().catch(() => ({}))) as { code?: string; error?: string };
  const kind = (body.code && REJECTION_BY_CODE[body.code]) || undefined;
  if (kind) return { ok: false, reason: { kind } };
  return { ok: false, reason: { kind: 'lookup_failed', detail: body.error } };
};

/** Raw cover bytes for the OG image, or null if the share has none / is dead. */
export const fetchShareCover = async (
  rawToken: string,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> => {
  const response = await fetch(
    `${internalBaseUrl()}/api/share/${encodeURIComponent(rawToken)}/cover`,
    { cache: 'no-store' },
  );
  if (!response.ok) return null;
  return {
    bytes: await response.arrayBuffer(),
    contentType: response.headers.get('content-type') ?? 'image/jpeg',
  };
};

export const rejectionToHttp = (
  reason: ShareLookupRejection,
): { status: number; body: { error: string; code?: string } } => {
  switch (reason.kind) {
    case 'invalid_token':
      return { status: 400, body: { error: 'Invalid share token', code: 'invalid_token' } };
    case 'not_found':
      return { status: 404, body: { error: 'Share not found', code: 'not_found' } };
    case 'revoked':
      return { status: 410, body: { error: 'Share has been revoked', code: 'revoked' } };
    case 'expired':
      return { status: 410, body: { error: 'Share has expired', code: 'expired' } };
    case 'source_deleted':
      return {
        status: 410,
        body: { error: 'Shared book is no longer available', code: 'source_deleted' },
      };
    case 'lookup_failed':
      console.error('Share lookup failed:', reason.detail);
      return { status: 500, body: { error: 'Could not look up share' } };
  }
};
