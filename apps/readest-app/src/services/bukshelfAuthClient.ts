import type { User } from '@supabase/supabase-js';
import { getBukshelfApiBaseUrl } from './runtimeConfig';

interface BukshelfSessionResponse {
  accessToken: string;
  expiresAt: number;
  user: User;
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
    | (Partial<BukshelfSessionResponse> & { error?: string; ok?: boolean })
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
