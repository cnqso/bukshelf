import { bukshelfProviderUrl, fetchWithAuth } from '@/utils/fetch';

// Book sharing lives entirely in the Bun backend (see
// apps/bukshelf-server/src/shareRoutes.ts) — no fallback to legacy Next.js
// API routes, matching the AI/TTS/usage migrations. Resolved per-call (not a
// module-level constant): bukshelfProviderUrl throws if unconfigured, and
// this module is imported by builds (Tauri, cloud) where that's expected.
const shareApi = (path = '') => bukshelfProviderUrl(`/api/share${path}`);

export interface CreateShareInput {
  bookHash: string;
  expirationDays: number; // must be one of [1, 3, 7]
  title: string;
  author?: string | null;
  format: string;
  // Note: `size` is intentionally not part of the input. The server reads the
  // canonical size from the stored book bytes to avoid client/server drift.
  cfi?: string | null;
}

export interface CreateShareResponse {
  token: string;
  url: string;
  expiresAt: string;
}

export interface ShareMetadata {
  title: string;
  author: string | null;
  format: string;
  size: number;
  expiresAt: string;
  hasCover: boolean;
  hasCfi: boolean;
  downloadCount: number;
  // Owner-only fields (returned only when the caller is the sharer).
  token?: string;
  bookHash?: string;
  createdAt?: string;
  revokedAt?: string | null;
}

export interface ShareListResponse {
  shares: Array<
    ShareMetadata & {
      token: string;
      bookHash: string;
      createdAt: string;
      revokedAt: string | null;
    }
  >;
  nextCursor: string | null;
}

export interface ImportShareResponse {
  fileId: string;
  alreadyOwned: boolean;
  bookHash: string;
  cfi: string | null;
}

export class ShareApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ShareApiError';
  }
}

const parseError = async (response: Response): Promise<ShareApiError> => {
  let code: string | undefined;
  let message = response.statusText || 'Request failed';
  try {
    const body = (await response.json()) as { error?: string; code?: string };
    if (body?.error) message = body.error;
    if (body?.code) code = body.code;
  } catch {
    // Body wasn't JSON; keep the default message.
  }
  return new ShareApiError(response.status, code, message);
};

const jsonHeaders = { 'Content-Type': 'application/json' };

// Owner-only. Creates a share row for an already-uploaded book.
export const createShare = async (input: CreateShareInput): Promise<CreateShareResponse> => {
  const response = await fetchWithAuth(shareApi('/create'), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as CreateShareResponse;
};

// Public. Used by the landing page to render metadata.
export const getShare = async (token: string): Promise<ShareMetadata> => {
  const response = await fetch(shareApi(`/${encodeURIComponent(token)}`), {
    method: 'GET',
    cache: 'no-store',
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as ShareMetadata;
};

// Owner-only. Revokes a share immediately.
export const revokeShare = async (token: string): Promise<void> => {
  const response = await fetchWithAuth(shareApi(`/${encodeURIComponent(token)}/revoke`), {
    method: 'POST',
  });
  if (!response.ok) throw await parseError(response);
};

// Owner-only. Paginated list of the caller's shares (active + expired).
export const listShares = async (cursor?: string | null): Promise<ShareListResponse> => {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const response = await fetchWithAuth(shareApi(`/list${qs}`), { method: 'GET' });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as ShareListResponse;
};

// Requires auth. Single-owner Bukshelf: the sharer and every authenticated
// caller are the same owner, so this only ever confirms the shared book is
// still present locally — there is no cross-account byte-copy to perform.
export const importShare = async (token: string): Promise<ImportShareResponse> => {
  const response = await fetchWithAuth(shareApi(`/${encodeURIComponent(token)}/import`), {
    method: 'POST',
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as ImportShareResponse;
};

// Public. Best-effort analytics ping fired by the landing page Download button
// and the in-app deeplink hook on a successful import. Failures are silent —
// the user-visible action does NOT depend on this succeeding.
export const confirmDownload = async (token: string): Promise<void> => {
  try {
    await fetch(shareApi(`/${encodeURIComponent(token)}/download/confirm`), {
      method: 'POST',
      cache: 'no-store',
      keepalive: true,
    });
  } catch {
    // Intentionally swallowed; this is analytics, not a gate.
  }
};
