import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthStore, OwnerRecord } from './authStore';

const SESSION_COOKIE = 'bukshelf_session';
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30;

interface SessionClaims {
  aud: 'authenticated';
  exp: number;
  iat: number;
  sub: string;
  email: string;
  role: 'authenticated';
  aal: 'aal1';
  jti: string;
  is_anonymous: false;
  plan: 'purchase';
  app_metadata: { provider: 'email'; providers: ['email'] };
  user_metadata: { email: string; email_verified: true; sub: string };
}

export interface BukshelfUser {
  id: string;
  email: string;
  aud: 'authenticated';
  role: 'authenticated';
  app_metadata: SessionClaims['app_metadata'];
  user_metadata: SessionClaims['user_metadata'];
}

export interface AuthSession {
  accessToken: string;
  expiresAt: number;
  tokenId: string;
  user: BukshelfUser;
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

const userFromClaims = (claims: SessionClaims): BukshelfUser => ({
  id: claims.sub,
  email: claims.email,
  aud: claims.aud,
  role: claims.role,
  app_metadata: claims.app_metadata,
  user_metadata: claims.user_metadata,
});

const readCookie = (request: Request, name: string): string | null => {
  for (const entry of request.headers.get('cookie')?.split(';') ?? []) {
    const separator = entry.indexOf('=');
    if (separator === -1) continue;
    if (entry.slice(0, separator).trim() === name) {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    }
  }
  return null;
};

export class AuthService {
  constructor(
    private readonly store: AuthStore,
    private readonly secret: string,
  ) {
    if (Buffer.byteLength(secret) < 32) {
      throw new Error('BUKSHELF_SESSION_SECRET must contain at least 32 bytes');
    }
  }

  get owner(): OwnerRecord | null {
    return this.store.getOwner();
  }

  async login(password: string): Promise<AuthSession | null> {
    const owner = this.owner;
    const passwordMatches = owner
      ? await Bun.password.verify(password, owner.passwordHash).catch(() => false)
      : false;
    if (!passwordMatches || !owner) return null;
    return this.issue(owner);
  }

  issue(owner: OwnerRecord): AuthSession {
    const now = Math.floor(Date.now() / 1000);
    const tokenId = randomBytes(24).toString('base64url');
    const claims: SessionClaims = {
      aud: 'authenticated',
      exp: now + SESSION_DURATION_SECONDS,
      iat: now,
      sub: owner.id,
      email: owner.email,
      role: 'authenticated',
      aal: 'aal1',
      jti: tokenId,
      is_anonymous: false,
      plan: 'purchase',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { email: owner.email, email_verified: true, sub: owner.id },
    };
    const accessToken = this.sign(claims);
    const expiresAt = claims.exp * 1000;
    this.store.pruneSessions();
    this.store.createSession(tokenId, expiresAt);
    return { accessToken, expiresAt, tokenId, user: userFromClaims(claims) };
  }

  authenticate(request: Request): AuthSession | null {
    const authorization = request.headers.get('authorization');
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : readCookie(request, SESSION_COOKIE);
    if (!token) return null;
    const claims = this.verify(token);
    if (!claims || !this.store.touchSession(claims.jti)) return null;
    return {
      accessToken: token,
      expiresAt: claims.exp * 1000,
      tokenId: claims.jti,
      user: userFromClaims(claims),
    };
  }

  revoke(session: AuthSession): void {
    this.store.revokeSession(session.tokenId);
  }

  sessionCookie(token: string, secure: boolean): string {
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_DURATION_SECONDS}; SameSite=Strict${secure ? '; Secure' : ''}`;
  }

  clearSessionCookie(secure: boolean): string {
    return `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${secure ? '; Secure' : ''}`;
  }

  private sign(claims: SessionClaims): string {
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const payload = encode(claims);
    const signature = createHmac('sha256', this.secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  private verify(token: string): SessionClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, suppliedSignature] = parts as [string, string, string];
    const expectedSignature = createHmac('sha256', this.secret)
      .update(`${header}.${payload}`)
      .digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(suppliedSignature, 'base64url');
    } catch {
      return null;
    }
    if (
      supplied.length !== expectedSignature.length ||
      !timingSafeEqual(supplied, expectedSignature)
    )
      return null;

    try {
      const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      const claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as SessionClaims;
      if (parsedHeader.alg !== 'HS256' || parsedHeader.typ !== 'JWT') return null;
      if (
        claims.aud !== 'authenticated' ||
        claims.role !== 'authenticated' ||
        claims.exp <= Math.floor(Date.now() / 1000) ||
        !claims.sub ||
        !claims.email ||
        !claims.jti
      )
        return null;
      return claims;
    } catch {
      return null;
    }
  }
}
