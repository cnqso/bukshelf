'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { IoArrowBack } from 'react-icons/io5';
import { useAuth } from '@/context/AuthContext';
import {
  getBukshelfAuthStatus,
  loginToBukshelf,
  setupBukshelf,
} from '@/services/bukshelfAuthClient';
import { getBrandName } from '@/services/runtimeConfig';
import {
  clearSelectedBukshelfServerUrl,
  DEFAULT_BUKSHELF_SERVER_URL,
  getSelectedBukshelfServerUrl,
  isMobileTauriClient,
  normalizeBukshelfServerUrl,
  setSelectedBukshelfServerUrl,
} from '@/services/mobileServer';

const safeRedirect = (redirect: string | null) =>
  redirect?.startsWith('/') && !redirect.startsWith('//') ? redirect : '/library';

export default function SingleOwnerAuthPage() {
  const router = useRouter();
  const { login } = useAuth();
  const brandName = getBrandName();
  const mobile = isMobileTauriClient();
  const selectedServer = getSelectedBukshelfServerUrl();
  const [serverUrl, setServerUrl] = useState(selectedServer || DEFAULT_BUKSHELF_SERVER_URL);
  const [serverConnected, setServerConnected] = useState(!mobile || Boolean(selectedServer));
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!serverConnected || configured !== null) return;
    void getBukshelfAuthStatus()
      .then((status) => {
        setConfigured(status.configured);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Could not check server setup');
      });
  }, [configured, serverConnected]);

  const handleServerConnect = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const normalized = normalizeBukshelfServerUrl(serverUrl);
      const status = await getBukshelfAuthStatus(normalized);
      setSelectedBukshelfServerUrl(normalized);
      setServerUrl(normalized);
      setConfigured(status.configured);
      setServerConnected(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not connect to this server');
    } finally {
      setLoading(false);
    }
  };

  const handleChangeServer = () => {
    clearSelectedBukshelfServerUrl();
    setConfigured(null);
    setServerConnected(false);
    setError('');
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') || '');
    const password = String(data.get('password') || '');
    if (configured === false && password !== String(data.get('confirmation') || '')) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const session = configured
        ? await loginToBukshelf(password)
        : await setupBukshelf(email, password);
      login(session.accessToken, session.user);
      router.replace(safeRedirect(new URLSearchParams(window.location.search).get('redirect')));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign in failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className='bg-base-100 flex min-h-dvh items-center justify-center px-6 py-16'>
      {!mobile && (
        <button
          type='button'
          aria-label='Go back'
          onClick={() => router.back()}
          className='btn btn-ghost fixed start-6 top-6 h-8 min-h-8 w-8 p-0'
        >
          <IoArrowBack aria-hidden='true' />
        </button>
      )}
      <div className='flex w-full max-w-sm flex-col items-center gap-7'>
        <Image src='/icon.png' alt='' width={64} height={64} className='h-16 w-16 rounded-2xl' />
        <div className='text-center'>
          <h1 className='text-xl font-semibold tracking-tight'>
            {!serverConnected
              ? `Connect ${brandName}`
              : configured === false
                ? `Set up ${brandName}`
                : `Unlock ${brandName}`}
          </h1>
          <p className='text-base-content/65 mt-2 text-sm leading-relaxed'>
            {!serverConnected
              ? 'Enter the address of your self-hosted Bukshelf server.'
              : configured === false
                ? 'Create the single owner account for this server.'
                : 'This shelf has one owner. Enter the server password to continue.'}
          </p>
        </div>
        {!serverConnected ? (
          <form onSubmit={handleServerConnect} className='w-full space-y-4'>
            <div className='form-control'>
              <label className='label' htmlFor='server-url'>
                <span className='label-text'>Server URL</span>
              </label>
              <input
                id='server-url'
                name='server-url'
                type='url'
                required
                autoFocus
                autoCapitalize='none'
                autoCorrect='off'
                spellCheck={false}
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder='http://192.168.1.10:43175'
                className='input input-bordered eink-bordered w-full rounded-lg'
                disabled={loading}
              />
            </div>
            <button type='submit' className='btn btn-primary w-full rounded-lg' disabled={loading}>
              {loading && (
                <span className='loading loading-spinner loading-sm' aria-hidden='true' />
              )}
              {loading ? 'Connecting…' : 'Connect'}
            </button>
            <p className='text-base-content/50 text-center text-xs leading-relaxed'>
              Local HTTP addresses are supported. Use HTTPS when connecting over an untrusted
              network.
            </p>
          </form>
        ) : (
          <form onSubmit={handleSubmit} className='w-full space-y-4'>
            {configured === false && (
              <div className='form-control'>
                <label className='label' htmlFor='email'>
                  <span className='label-text'>Email</span>
                </label>
                <input
                  id='email'
                  name='email'
                  type='email'
                  required
                  autoFocus
                  autoComplete='email'
                  placeholder='you@example.com'
                  className='input input-bordered eink-bordered w-full rounded-lg'
                  disabled={loading}
                />
              </div>
            )}
            <div className='form-control'>
              <label className='label' htmlFor='password'>
                <span className='label-text'>Password</span>
              </label>
              <input
                id='password'
                name='password'
                type='password'
                required
                autoFocus={configured === true}
                autoComplete={configured === false ? 'new-password' : 'current-password'}
                placeholder='Your Bukshelf password'
                className='input input-bordered eink-bordered w-full rounded-lg'
                disabled={loading || configured === null}
              />
            </div>
            {configured === false && (
              <div className='form-control'>
                <label className='label' htmlFor='confirmation'>
                  <span className='label-text'>Confirm password</span>
                </label>
                <input
                  id='confirmation'
                  name='confirmation'
                  type='password'
                  required
                  autoComplete='new-password'
                  className='input input-bordered eink-bordered w-full rounded-lg'
                  disabled={loading}
                />
              </div>
            )}
            <button
              type='submit'
              className='btn btn-primary w-full rounded-lg'
              disabled={loading || configured === null}
            >
              {loading && (
                <span className='loading loading-spinner loading-sm' aria-hidden='true' />
              )}
              {loading
                ? configured === false
                  ? 'Creating owner…'
                  : 'Unlocking…'
                : configured === false
                  ? 'Create owner'
                  : 'Unlock shelf'}
            </button>
          </form>
        )}
        {error && (
          <div className='eink-bordered border-error/30 bg-error/5 text-error w-full rounded-lg border px-3 py-2.5 text-center text-sm'>
            {error}
          </div>
        )}
        {serverConnected && configured !== false && (
          <p className='text-base-content/50 text-center text-xs leading-relaxed'>
            Password recovery is performed locally with the Bukshelf CLI.
          </p>
        )}
        {mobile && serverConnected && (
          <button type='button' className='btn btn-ghost btn-sm' onClick={handleChangeServer}>
            Change server
          </button>
        )}
      </div>
    </main>
  );
}
