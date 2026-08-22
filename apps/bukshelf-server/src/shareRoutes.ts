import { randomBytes } from 'node:crypto';
import type { AuthService } from './auth';
import type { ObjectStore } from './objectStore';
import type { ShareRow, ShareStore } from './shareStore';

export interface ShareRouteConfig {
  auth: AuthService;
  shares: ShareStore;
  objects: ObjectStore;
  publicOrigin?: string;
}

const cors = (origin?: string) => ({
  ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type',
});

const json = (body: unknown, config: ShareRouteConfig, init: ResponseInit = {}) =>
  Response.json(body, {
    ...init,
    headers: { 'cache-control': 'no-store', ...cors(config.publicOrigin), ...init.headers },
  });

const SHARE_TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SHARE_TOKEN_LENGTH = 22;
const SHARE_TOKEN_RE = new RegExp(`^[${SHARE_TOKEN_ALPHABET}]{${SHARE_TOKEN_LENGTH}}$`);
const SHARE_EXPIRATION_DAYS = [1, 3, 7] as const;
const SHARE_MAX_ACTIVE = 50;
const SHARE_CFI_MAX_LENGTH = 512;
const DAY_MS = 24 * 60 * 60 * 1000;

// Rejection-sampled so every character is drawn uniformly from the 62-char
// alphabet (a plain `% 62` would bias the last few letters).
export const generateToken = (): string => {
  const alphabetSize = SHARE_TOKEN_ALPHABET.length;
  const maxUnbiased = 256 - (256 % alphabetSize);
  let token = '';
  while (token.length < SHARE_TOKEN_LENGTH) {
    const bytes = randomBytes(SHARE_TOKEN_LENGTH * 2);
    for (const byte of bytes) {
      if (token.length >= SHARE_TOKEN_LENGTH) break;
      if (byte >= maxUnbiased) continue;
      token += SHARE_TOKEN_ALPHABET[byte % alphabetSize];
    }
  }
  return token;
};

export const hashToken = async (raw: string): Promise<string> => {
  const data = new TextEncoder().encode(raw);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export const isValidToken = (value: unknown): value is string =>
  typeof value === 'string' && SHARE_TOKEN_RE.test(value);

const trimText = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

// Reject C0 controls and DEL: the cfi round-trips into URLs and gets embedded
// in the landing page's HTML.
const hasControlChar = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value);

type ShareRejection = 'invalid_token' | 'not_found' | 'revoked' | 'expired' | 'source_deleted';

const REJECTION_STATUS: Record<ShareRejection, number> = {
  invalid_token: 400,
  not_found: 404,
  revoked: 410,
  expired: 410,
  source_deleted: 410,
};

const REJECTION_MESSAGE: Record<ShareRejection, string> = {
  invalid_token: 'Invalid share token',
  not_found: 'Share not found',
  revoked: 'Share has been revoked',
  expired: 'Share has expired',
  source_deleted: 'Shared book is no longer available',
};

/**
 * Resolves a token to an active share plus a live confirmation that the
 * underlying book bytes still exist. Unlike the legacy Postgres/MinIO path,
 * there's no separate `files` table to join — the object store IS the source
 * of truth for whether the book is still there.
 */
const resolveActiveShare = async (
  config: ShareRouteConfig,
  rawToken: string,
): Promise<{ share: ShareRow } | { rejection: ShareRejection }> => {
  if (!isValidToken(rawToken)) return { rejection: 'invalid_token' };
  const share = config.shares.findByTokenHash(await hashToken(rawToken));
  if (!share) return { rejection: 'not_found' };
  if (share.revokedAt) return { rejection: 'revoked' };
  if (new Date(share.expiresAt).getTime() < Date.now()) return { rejection: 'expired' };
  if (!(await config.objects.findBook(share.bookHash))) return { rejection: 'source_deleted' };
  return { share };
};

const rejectionResponse = (rejection: ShareRejection, config: ShareRouteConfig) =>
  json({ error: REJECTION_MESSAGE[rejection], code: rejection }, config, {
    status: REJECTION_STATUS[rejection],
  });

const shareUrlFor = (request: Request, config: ShareRouteConfig, token: string): string => {
  const base = config.publicOrigin || new URL(request.url).origin;
  return `${base}/s/${token}`;
};

const handleCreate = async (request: Request, config: ShareRouteConfig): Promise<Response> => {
  const session = config.auth.authenticate(request);
  if (!session) return json({ error: 'Not authenticated' }, config, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON body' }, config, { status: 400 });
  }

  const bookHash = trimText(body.bookHash, 64);
  if (!bookHash) return json({ error: 'Missing or invalid bookHash' }, config, { status: 400 });

  const expirationDays = body.expirationDays;
  if (
    typeof expirationDays !== 'number' ||
    !(SHARE_EXPIRATION_DAYS as readonly number[]).includes(expirationDays)
  ) {
    return json(
      {
        error: `expirationDays must be one of ${SHARE_EXPIRATION_DAYS.join(', ')}`,
        code: 'invalid_expiration',
      },
      config,
      { status: 400 },
    );
  }

  const title = trimText(body.title, 512);
  if (!title) return json({ error: 'Missing or invalid title' }, config, { status: 400 });
  const author = trimText(body.author, 256);
  const format = trimText(body.format, 16);
  if (!format) return json({ error: 'Missing or invalid format' }, config, { status: 400 });

  let cfi: string | null = null;
  if (body.cfi != null) {
    cfi = trimText(body.cfi, SHARE_CFI_MAX_LENGTH);
    if (cfi && hasControlChar(cfi)) {
      return json({ error: 'cfi contains invalid characters' }, config, { status: 400 });
    }
  }

  if (config.shares.countActive() >= SHARE_MAX_ACTIVE) {
    return json(
      {
        error: `You have reached the maximum of ${SHARE_MAX_ACTIVE} active shares.`,
        code: 'share_limit_reached',
      },
      config,
      { status: 429 },
    );
  }

  const book = await config.objects.findBook(bookHash);
  if (!book) {
    return json({ error: 'Book is not uploaded yet', code: 'book_not_uploaded' }, config, {
      status: 409,
    });
  }
  // Canonical size comes from the actual stored bytes, never the client, to
  // avoid client/server drift.
  const size = Bun.file(book.path).size;

  const token = generateToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + expirationDays * DAY_MS).toISOString();

  config.shares.create({
    tokenHash,
    token,
    bookHash,
    bookTitle: title,
    bookAuthor: author,
    bookFormat: format,
    bookSize: size,
    cfi,
    expiresAt,
  });

  return json({ token, url: shareUrlFor(request, config, token), expiresAt }, config);
};

const shareToListEntry = (row: ShareRow) => ({
  id: row.id,
  token: row.token,
  bookHash: row.bookHash,
  title: row.bookTitle,
  author: row.bookAuthor,
  format: row.bookFormat,
  size: row.bookSize,
  hasCfi: !!row.cfi,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
  downloadCount: row.downloadCount,
  createdAt: row.createdAt,
});

const handleList = (request: Request, config: ShareRouteConfig): Response => {
  const session = config.auth.authenticate(request);
  if (!session) return json({ error: 'Not authenticated' }, config, { status: 401 });

  const url = new URL(request.url);
  const page = config.shares.list({ cursor: url.searchParams.get('cursor'), pageSize: 25 });
  const last = page.rows.at(-1);
  const nextCursor = page.hasMore && last ? `${last.createdAt}|${last.id}` : null;

  return json(
    {
      shares: page.rows.map(shareToListEntry),
      nextCursor,
      shareUrlBase: `${config.publicOrigin || new URL(request.url).origin}/s`,
    },
    config,
  );
};

const handleRevoke = async (
  request: Request,
  config: ShareRouteConfig,
  token: string,
): Promise<Response> => {
  if (!isValidToken(token)) return json({ error: 'Invalid share token' }, config, { status: 400 });
  const session = config.auth.authenticate(request);
  if (!session) return json({ error: 'Not authenticated' }, config, { status: 401 });

  config.shares.revoke(await hashToken(token));
  return new Response(null, { status: 204, headers: cors(config.publicOrigin) });
};

const handleMetadata = async (
  request: Request,
  config: ShareRouteConfig,
  token: string,
): Promise<Response> => {
  const result = await resolveActiveShare(config, token);
  if ('rejection' in result) return rejectionResponse(result.rejection, config);
  const { share } = result;
  const cover = await config.objects.readCover(share.bookHash);

  return json(
    {
      title: share.bookTitle,
      author: share.bookAuthor,
      format: share.bookFormat,
      size: share.bookSize,
      expiresAt: share.expiresAt,
      hasCover: !!cover,
      hasCfi: !!share.cfi,
      downloadCount: share.downloadCount,
    },
    config,
    { headers: { 'cache-control': 'private, no-store' } },
  );
};

const handleCover = async (
  request: Request,
  config: ShareRouteConfig,
  token: string,
): Promise<Response> => {
  const result = await resolveActiveShare(config, token);
  if ('rejection' in result) return rejectionResponse(result.rejection, config);
  const cover = await config.objects.readCover(result.share.bookHash);
  if (!cover) return json({ error: 'No cover for this share' }, config, { status: 404 });

  return new Response(new Uint8Array(cover.body), {
    headers: {
      ...cors(config.publicOrigin),
      'content-type': cover.contentType,
      'content-length': String(cover.body.byteLength),
      'cache-control': 'public, max-age=300',
      // Chat/unfurl previews and the landing page both embed this cross-origin.
      'cross-origin-resource-policy': 'cross-origin',
    },
  });
};

const CONTENT_TYPE_BY_FORMAT: Record<string, string> = {
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
};

const handleDownload = async (
  request: Request,
  config: ShareRouteConfig,
  token: string,
): Promise<Response> => {
  const result = await resolveActiveShare(config, token);
  if ('rejection' in result) return rejectionResponse(result.rejection, config);
  const { share } = result;
  const book = await config.objects.findBook(share.bookHash);
  if (!book) return rejectionResponse('source_deleted', config);

  const filename = `${share.bookTitle}.${share.bookFormat.toLowerCase()}`.replace(/["\\]/g, '_');
  return new Response(Bun.file(book.path), {
    headers: {
      ...cors(config.publicOrigin),
      'content-type': CONTENT_TYPE_BY_FORMAT[book.format] ?? 'application/octet-stream',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  });
};

const handleDownloadConfirm = async (
  request: Request,
  config: ShareRouteConfig,
  token: string,
): Promise<Response> => {
  // Best-effort beacon: an invalid or dead token is silently a no-op, never a
  // gate. The route body increments only rows that are still active.
  if (isValidToken(token)) config.shares.incrementDownload(await hashToken(token));
  return new Response(null, {
    status: 204,
    headers: { ...cors(config.publicOrigin), 'cache-control': 'private, no-store' },
  });
};

const handleImport = async (
  request: Request,
  config: ShareRouteConfig,
  token: string,
): Promise<Response> => {
  const session = config.auth.authenticate(request);
  if (!session) return json({ error: 'Not authenticated' }, config, { status: 401 });

  const result = await resolveActiveShare(config, token);
  if ('rejection' in result) return rejectionResponse(result.rejection, config);
  const { share } = result;

  // Single-owner Bukshelf: the sharer and every authenticated caller are the
  // same owner, so a share can only ever reference a book already in this
  // library. resolveActiveShare already confirmed the bytes are still there.
  return json(
    { fileId: share.bookHash, alreadyOwned: true, bookHash: share.bookHash, cfi: share.cfi },
    config,
  );
};

const TOKEN_PATH = /^\/api\/share\/([^/]+)$/;
const TOKEN_SUBROUTE_PATH = /^\/api\/share\/([^/]+)\/(revoke|cover|download|import)$/;
const DOWNLOAD_CONFIRM_PATH = /^\/api\/share\/([^/]+)\/download\/confirm$/;

export const handleShareRoute = async (
  request: Request,
  config: ShareRouteConfig,
): Promise<Response | undefined> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/share')) return undefined;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors(config.publicOrigin) });
  }

  if (url.pathname === '/api/share/create' && request.method === 'POST') {
    return handleCreate(request, config);
  }
  if (url.pathname === '/api/share/list' && request.method === 'GET') {
    return handleList(request, config);
  }

  const confirmMatch = url.pathname.match(DOWNLOAD_CONFIRM_PATH);
  if (confirmMatch && request.method === 'POST') {
    return handleDownloadConfirm(request, config, confirmMatch[1]!);
  }

  const subrouteMatch = url.pathname.match(TOKEN_SUBROUTE_PATH);
  if (subrouteMatch) {
    const [, token, action] = subrouteMatch as unknown as [string, string, string];
    if (action === 'revoke' && request.method === 'POST') {
      return handleRevoke(request, config, token);
    }
    if (action === 'cover' && request.method === 'GET') {
      return handleCover(request, config, token);
    }
    if (action === 'download' && request.method === 'GET') {
      return handleDownload(request, config, token);
    }
    if (action === 'import' && request.method === 'POST') {
      return handleImport(request, config, token);
    }
    return json({ error: 'Method not allowed' }, config, { status: 405 });
  }

  const tokenMatch = url.pathname.match(TOKEN_PATH);
  if (tokenMatch && request.method === 'GET') {
    return handleMetadata(request, config, tokenMatch[1]!);
  }

  return json({ error: 'Not found' }, config, { status: 404 });
};
