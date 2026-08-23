export const BUKSHELF_SERVER_URL_KEY = 'bukshelf.serverUrl';
export const DEFAULT_BUKSHELF_SERVER_URL = 'https://books.cnqso.com';

export const isMobileTauriClient = () => {
  if (process.env['NEXT_PUBLIC_APP_PLATFORM'] !== 'tauri' || typeof navigator === 'undefined') {
    return false;
  }
  const isMobileUserAgent = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isDesktopModeIPad = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return isMobileUserAgent || isDesktopModeIPad;
};

export const normalizeBukshelfServerUrl = (input: string) => {
  const value = input.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a complete server URL, including http:// or https://');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Bukshelf server URLs must use http:// or https://');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The server URL cannot include credentials, a query, or a fragment');
  }
  return url.toString().replace(/\/$/, '');
};

export const getSelectedBukshelfServerUrl = () => {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(BUKSHELF_SERVER_URL_KEY) || '';
};

export const setSelectedBukshelfServerUrl = (input: string) => {
  const serverUrl = normalizeBukshelfServerUrl(input);
  const previous = getSelectedBukshelfServerUrl();
  if (previous !== serverUrl) clearBukshelfSession();
  localStorage.setItem(BUKSHELF_SERVER_URL_KEY, serverUrl);
  return serverUrl;
};

export const clearBukshelfSession = () => {
  localStorage.removeItem('token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('user');
};

export const clearSelectedBukshelfServerUrl = () => {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(BUKSHELF_SERVER_URL_KEY);
  clearBukshelfSession();
};
