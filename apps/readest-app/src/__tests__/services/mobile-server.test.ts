import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUKSHELF_SERVER_URL_KEY,
  clearSelectedBukshelfServerUrl,
  getSelectedBukshelfServerUrl,
  isMobileTauriClient,
  normalizeBukshelfServerUrl,
  setSelectedBukshelfServerUrl,
} from '@/services/mobileServer';

describe('mobile Bukshelf server selection', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('accepts HTTP and HTTPS and removes only the trailing slash', () => {
    expect(normalizeBukshelfServerUrl(' http://192.168.1.20:43175/ ')).toBe(
      'http://192.168.1.20:43175',
    );
    expect(normalizeBukshelfServerUrl('https://example.com/books/')).toBe(
      'https://example.com/books',
    );
  });

  it('rejects ambiguous or unsafe server URL forms', () => {
    expect(() => normalizeBukshelfServerUrl('example.com')).toThrow(/including http/);
    expect(() => normalizeBukshelfServerUrl('ftp://example.com')).toThrow(/http:\/\//);
    expect(() => normalizeBukshelfServerUrl('https://u:p@example.com')).toThrow(/credentials/);
    expect(() => normalizeBukshelfServerUrl('https://example.com?q=1')).toThrow(/query/);
  });

  it('persists one server and clears credentials when it changes or disconnects', () => {
    localStorage.setItem('token', 'old-token');
    localStorage.setItem('user', '{}');
    setSelectedBukshelfServerUrl('http://localhost:43175');
    expect(localStorage.getItem('token')).toBeNull();

    localStorage.setItem('token', 'current-token');
    setSelectedBukshelfServerUrl('http://localhost:43175');
    expect(localStorage.getItem('token')).toBe('current-token');

    setSelectedBukshelfServerUrl('https://books.example.com');
    expect(getSelectedBukshelfServerUrl()).toBe('https://books.example.com');
    expect(localStorage.getItem('token')).toBeNull();

    clearSelectedBukshelfServerUrl();
    expect(localStorage.getItem(BUKSHELF_SERVER_URL_KEY)).toBeNull();
  });

  it('identifies only mobile Tauri clients', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'tauri');
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Linux; Android 15)',
    );
    expect(isMobileTauriClient()).toBe(true);

    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    expect(isMobileTauriClient()).toBe(false);
  });
});
