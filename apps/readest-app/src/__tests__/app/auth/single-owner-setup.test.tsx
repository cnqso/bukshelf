import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SingleOwnerAuthPage from '@/app/auth/components/SingleOwnerAuthPage';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  replace: vi.fn(),
  setup: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), replace: mocks.replace }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ login: mocks.login }) }));
vi.mock('@/services/runtimeConfig', () => ({ getBrandName: () => 'Bukshelf' }));
vi.mock('@/services/bukshelfAuthClient', () => ({
  getBukshelfAuthStatus: vi.fn().mockResolvedValue({
    configured: false,
  }),
  loginToBukshelf: vi.fn(),
  setupBukshelf: mocks.setup,
}));

describe('single-owner first-run setup', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('creates and signs in the fixed owner after matching password confirmation', async () => {
    mocks.setup.mockResolvedValue({
      accessToken: 'owner-token',
      user: { id: 'owner', email: 'owner@example.com' },
    });
    render(<SingleOwnerAuthPage />);

    expect(await screen.findByRole('heading', { name: 'Set up Bukshelf' })).toBeTruthy();
    expect(screen.getByText('Create the password for this server’s single owner.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create owner' }));

    await waitFor(() => expect(mocks.setup).toHaveBeenCalledWith('correct horse battery staple'));
    expect(mocks.login).toHaveBeenCalledWith('owner-token', {
      id: 'owner',
      email: 'owner@example.com',
    });
    expect(mocks.replace).toHaveBeenCalledWith('/library');
  });
});
