import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MobileConnectionGate from '@/components/MobileConnectionGate';

const mocks = vi.hoisted(() => ({
  pathname: '/library',
  replace: vi.fn(),
  serverUrl: '',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ token: null, user: null }),
}));
vi.mock('@/services/mobileServer', () => ({
  getSelectedBukshelfServerUrl: () => mocks.serverUrl,
  isMobileTauriClient: () => true,
}));

describe('mobile connection gate', () => {
  afterEach(() => {
    cleanup();
    mocks.pathname = '/library';
    mocks.serverUrl = '';
    vi.clearAllMocks();
  });

  it('hides protected routes and sends first launch to server setup', async () => {
    render(
      <MobileConnectionGate>
        <div>Private library</div>
      </MobileConnectionGate>,
    );

    expect(screen.queryByText('Private library')).toBeNull();
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/auth?redirect=%2Flibrary'));
  });

  it('always allows the auth route to render', () => {
    mocks.pathname = '/auth';
    render(
      <MobileConnectionGate>
        <div>Connect server</div>
      </MobileConnectionGate>,
    );
    expect(screen.getByText('Connect server')).toBeTruthy();
  });
});
