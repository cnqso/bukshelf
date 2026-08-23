import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SingleOwnerAuthPage from '@/app/auth/components/SingleOwnerAuthPage';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  saveServer: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ login: vi.fn() }) }));
vi.mock('@/services/runtimeConfig', () => ({ getBrandName: () => 'Bukshelf' }));
vi.mock('@/services/mobileServer', () => ({
  clearSelectedBukshelfServerUrl: vi.fn(),
  DEFAULT_BUKSHELF_SERVER_URL: 'https://books.cnqso.com',
  getSelectedBukshelfServerUrl: () => '',
  isMobileTauriClient: () => true,
  normalizeBukshelfServerUrl: (value: string) => value.replace(/\/$/, ''),
  setSelectedBukshelfServerUrl: mocks.saveServer,
}));
vi.mock('@/services/bukshelfAuthClient', () => ({
  getBukshelfAuthStatus: mocks.status,
  loginToBukshelf: vi.fn(),
  setupBukshelf: vi.fn(),
}));

describe('mobile server connection', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('probes and persists the chosen server before showing login', async () => {
    mocks.status.mockResolvedValue({ configured: true });
    render(<SingleOwnerAuthPage />);

    expect(screen.getByRole('heading', { name: 'Connect Bukshelf' })).toBeTruthy();
    expect(screen.getByLabelText('Server URL')).toHaveProperty('value', 'https://books.cnqso.com');
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'http://192.168.1.20:43175/' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(mocks.status).toHaveBeenCalledWith('http://192.168.1.20:43175'));
    expect(mocks.saveServer).toHaveBeenCalledWith('http://192.168.1.20:43175');
    expect(await screen.findByRole('heading', { name: 'Unlock Bukshelf' })).toBeTruthy();
  });
});
