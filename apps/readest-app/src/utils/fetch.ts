import { getAccessToken } from './access';

export const fetchWithTimeout = (url: string, options: RequestInit = {}, timeout = 10000) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort('Request timed out'), timeout);

  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(id));
};

export const fetchWithAuth = async (url: string, options: RequestInit) => {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('Not authenticated');
  }
  const headers = {
    ...options.headers,
    Authorization: `Bearer ${token}`,
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    const errorData = (await response.json().catch(() => null)) as {
      error?: string | { message?: unknown };
    } | null;
    const error = errorData?.error;
    const message =
      typeof error === 'string'
        ? error
        : error && typeof error.message === 'string'
          ? error.message
          : null;
    console.error('Error:', message || response.statusText);
    throw new Error(message || 'Request failed');
  }

  return response;
};
