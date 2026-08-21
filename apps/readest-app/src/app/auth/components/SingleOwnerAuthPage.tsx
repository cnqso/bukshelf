'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IoArrowBack } from 'react-icons/io5';
import { useAuth } from '@/context/AuthContext';
import {
  getBukshelfAuthStatus,
  loginToBukshelf,
  setupBukshelf,
} from '@/services/bukshelfAuthClient';
import { getBrandName } from '@/services/runtimeConfig';

const safeRedirect = (redirect: string | null) =>
  redirect?.startsWith('/') && !redirect.startsWith('//') ? redirect : '/library';

export default function SingleOwnerAuthPage() {
  const router = useRouter();
  const { login } = useAuth();
  const brandName = getBrandName();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void getBukshelfAuthStatus()
      .then((status) => {
        setConfigured(status.configured);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Could not check server setup');
      });
  }, []);

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
      <button
        type='button'
        aria-label='Go back'
        onClick={() => router.back()}
        className='btn btn-ghost fixed start-6 top-6 h-8 min-h-8 w-8 p-0'
      >
        <IoArrowBack aria-hidden='true' />
      </button>
      <div className='flex w-full max-w-sm flex-col items-center gap-7'>
        <span className='bg-base-content text-base-100 grid h-14 w-14 place-items-center rounded-2xl font-serif text-3xl font-semibold shadow-sm'>
          {brandName.charAt(0).toUpperCase()}
        </span>
        <div className='text-center'>
          <h1 className='text-xl font-semibold tracking-tight'>
            {configured === false ? `Set up ${brandName}` : `Unlock ${brandName}`}
          </h1>
          <p className='text-base-content/65 mt-2 text-sm leading-relaxed'>
            {configured === false
              ? 'Create the single owner account for this server.'
              : 'This shelf has one owner. Enter the server password to continue.'}
          </p>
        </div>
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
              minLength={configured === false ? 12 : undefined}
              autoFocus={configured === true}
              autoComplete={configured === false ? 'new-password' : 'current-password'}
              placeholder={
                configured === false ? 'At least 12 characters' : 'Your Bukshelf password'
              }
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
                minLength={12}
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
            {loading && <span className='loading loading-spinner loading-sm' aria-hidden='true' />}
            {loading
              ? configured === false
                ? 'Creating owner…'
                : 'Unlocking…'
              : configured === false
                ? 'Create owner'
                : 'Unlock shelf'}
          </button>
          {error && (
            <div className='eink-bordered border-error/30 bg-error/5 text-error rounded-lg border px-3 py-2.5 text-center text-sm'>
              {error}
            </div>
          )}
        </form>
        {configured !== false && (
          <p className='text-base-content/50 text-center text-xs leading-relaxed'>
            Password recovery is performed locally with the Bukshelf CLI.
          </p>
        )}
      </div>
    </main>
  );
}
