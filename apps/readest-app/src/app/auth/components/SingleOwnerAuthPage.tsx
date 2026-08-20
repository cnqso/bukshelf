'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { IoArrowBack } from 'react-icons/io5';
import { useAuth } from '@/context/AuthContext';
import { loginToBukshelf } from '@/services/bukshelfAuthClient';
import { getBrandName } from '@/services/runtimeConfig';

const safeRedirect = (redirect: string | null) =>
  redirect?.startsWith('/') && !redirect.startsWith('//') ? redirect : '/library';

export default function SingleOwnerAuthPage() {
  const router = useRouter();
  const { login } = useAuth();
  const brandName = getBrandName();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password') || '');
    setLoading(true);
    setError('');
    try {
      const session = await loginToBukshelf(password);
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
          <h1 className='text-xl font-semibold tracking-tight'>Unlock {brandName}</h1>
          <p className='text-base-content/65 mt-2 text-sm leading-relaxed'>
            This shelf has one owner. Enter the server password to continue.
          </p>
        </div>
        <form onSubmit={handleSubmit} className='w-full space-y-4'>
          <div className='form-control'>
            <label className='label' htmlFor='password'>
              <span className='label-text'>Password</span>
            </label>
            <input
              id='password'
              name='password'
              type='password'
              required
              autoFocus
              autoComplete='current-password'
              placeholder='Your Bukshelf password'
              className='input input-bordered eink-bordered w-full rounded-lg'
              disabled={loading}
            />
          </div>
          <button type='submit' className='btn btn-primary w-full rounded-lg' disabled={loading}>
            {loading && <span className='loading loading-spinner loading-sm' aria-hidden='true' />}
            {loading ? 'Unlocking…' : 'Unlock shelf'}
          </button>
          {error && (
            <div className='eink-bordered border-error/30 bg-error/5 text-error rounded-lg border px-3 py-2.5 text-center text-sm'>
              {error}
            </div>
          )}
        </form>
        <p className='text-base-content/50 text-center text-xs leading-relaxed'>
          Password recovery is performed locally with the Bukshelf CLI.
        </p>
      </div>
    </main>
  );
}
