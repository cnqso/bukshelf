import type { AuthUser } from '@/types/auth';
import { getBukshelfApiBaseUrl } from './runtimeConfig';

interface BukshelfSessionResponse {
  accessToken: string;
  expiresAt: number;
  user: AuthUser;
}

export interface BukshelfAuthStatus {
  configured: boolean;
}

const authRequest = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(`${getBukshelfApiBaseUrl()}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as
    | (Partial<BukshelfSessionResponse> &
        Partial<BukshelfAuthStatus> & { error?: string; ok?: boolean })
    | null;
  if (!response.ok) throw new Error(body?.error || 'Authentication request failed');
  return body;
};

export const loginToBukshelf = async (password: string): Promise<BukshelfSessionResponse> => {
  const body = await authRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  if (!body?.accessToken || !body.user) throw new Error('Invalid authentication response');
  return body as BukshelfSessionResponse;
};

export const getBukshelfAuthStatus = async (): Promise<BukshelfAuthStatus> => {
  const body = await authRequest('/api/auth/status');
  if (typeof body?.configured !== 'boolean') throw new Error('Invalid setup status response');
  return body as BukshelfAuthStatus;
};

export const setupBukshelf = async (
  email: string,
  password: string,
): Promise<BukshelfSessionResponse> => {
  const body = await authRequest('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (!body?.accessToken || !body.user) throw new Error('Invalid authentication response');
  return body as BukshelfSessionResponse;
};

export const restoreBukshelfSession = async (
  accessToken?: string | null,
): Promise<BukshelfSessionResponse> => {
  const body = await authRequest('/api/auth/session', {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : undefined,
  });
  if (!body?.accessToken || !body.user) throw new Error('Invalid authentication response');
  return body as BukshelfSessionResponse;
};

export const logoutOfBukshelf = async (accessToken?: string | null): Promise<void> => {
  await authRequest('/api/auth/logout', {
    method: 'POST',
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : undefined,
  });
};
