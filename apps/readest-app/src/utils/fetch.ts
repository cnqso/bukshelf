import { getAccessToken } from './access';
import { getBukshelfApiBaseUrl } from '@/services/runtimeConfig';

/**
 * Server-managed Reader AI, Soniox TTS, and usage metering live in the
 * Bukshelf Bun backend. There is deliberately no fallback to legacy Next.js
 * API routes: a missing Bukshelf endpoint is a configuration error.
 */
export const bukshelfProviderUrl = (path: string): string => {
  const base = getBukshelfApiBaseUrl();
  if (!base) {
    throw new Error(
      'Bukshelf API URL is not configured. Set BUKSHELF_API_PUBLIC_URL so the app can reach the AI/TTS backend.',
    );
  }
  return `${base}${path}`;
};

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
