'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { PiArrowRight, PiBookOpenText } from 'react-icons/pi';
import { getBrandName, getSourceCodeUrl } from '@/services/runtimeConfig';

interface PublicBook {
  id: string;
  title: string;
  author: string | null;
  coverUrl: string | null;
}

type LibraryState =
  | { status: 'loading'; books: PublicBook[] }
  | { status: 'ready'; books: PublicBook[] }
  | { status: 'error'; books: PublicBook[] };

export default function PublicLibraryPage() {
  const brandName = getBrandName();
  const sourceCodeUrl = getSourceCodeUrl();
  const [library, setLibrary] = useState<LibraryState>({ status: 'loading', books: [] });

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/public/library', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Library request failed');
        return (await response.json()) as { books: PublicBook[] };
      })
      .then(({ books }) => setLibrary({ status: 'ready', books }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLibrary({ status: 'error', books: [] });
      });
    return () => controller.abort();
  }, []);

  return (
    <main className='bg-base-100 text-base-content min-h-dvh'>
      <header className='border-base-300/70 sticky top-0 z-20 border-b bg-base-100/90 backdrop-blur-xl'>
        <div className='mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8'>
          <div className='flex items-center gap-3' aria-label={brandName}>
            <span className='bg-base-content text-base-100 grid h-9 w-9 place-items-center rounded-xl font-serif text-xl font-semibold shadow-sm'>
              {brandName.charAt(0).toUpperCase()}
            </span>
            <span className='font-serif text-xl font-semibold tracking-tight'>{brandName}</span>
          </div>
          <Link
            href='/auth?redirect=/'
            className='btn btn-sm btn-neutral rounded-full px-5 font-medium'
          >
            Log in
            <PiArrowRight aria-hidden='true' className='h-4 w-4' />
          </Link>
        </div>
      </header>

      <section className='mx-auto max-w-7xl px-5 pb-20 pt-12 sm:px-8 sm:pt-16'>
        <div className='max-w-2xl'>
          <p className='text-base-content/55 mb-3 text-xs font-semibold uppercase tracking-[0.2em]'>
            The cloud library
          </p>
          <h1 className='font-serif text-4xl font-semibold leading-tight tracking-tight sm:text-6xl'>
            Books worth keeping close.
          </h1>
          <p className='text-base-content/65 mt-5 max-w-xl text-base leading-relaxed sm:text-lg'>
            Browse the shelf here. Reading, notes, and files stay private behind login.
          </p>
        </div>

        {library.status === 'loading' && (
          <div
            className='mt-12 grid grid-cols-2 gap-x-5 gap-y-10 sm:grid-cols-3 sm:gap-x-7 lg:grid-cols-5 xl:grid-cols-6'
            aria-label='Loading library'
          >
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className='animate-pulse'>
                <div className='bg-base-300 aspect-[2/3] rounded-xl' />
                <div className='bg-base-300 mt-4 h-4 w-4/5 rounded' />
                <div className='bg-base-300 mt-2 h-3 w-3/5 rounded' />
              </div>
            ))}
          </div>
        )}

        {library.status === 'error' && (
          <div className='border-base-300 bg-base-200/50 mt-12 rounded-2xl border p-8'>
            <p className='font-medium'>The shelf could not be loaded.</p>
            <p className='text-base-content/60 mt-1 text-sm'>Please try refreshing the page.</p>
          </div>
        )}

        {library.status === 'ready' && library.books.length === 0 && (
          <div className='border-base-300 bg-base-200/50 mt-12 flex flex-col items-center rounded-2xl border px-6 py-14 text-center'>
            <PiBookOpenText className='text-base-content/35 h-10 w-10' aria-hidden='true' />
            <p className='mt-4 font-medium'>The public shelf is empty.</p>
            <p className='text-base-content/60 mt-1 text-sm'>Cloud books will appear here.</p>
          </div>
        )}

        {library.status === 'ready' && library.books.length > 0 && (
          <div className='mt-12 grid grid-cols-2 gap-x-5 gap-y-10 sm:grid-cols-3 sm:gap-x-7 lg:grid-cols-5 xl:grid-cols-6'>
            {library.books.map((book, index) => (
              <article key={book.id} className='min-w-0'>
                <div className='bg-base-200 relative aspect-[2/3] overflow-hidden rounded-xl shadow-[0_16px_34px_-20px_rgba(0,0,0,0.6)] ring-1 ring-black/10'>
                  {book.coverUrl ? (
                    <Image
                      src={book.coverUrl}
                      alt={`Cover of ${book.title}`}
                      fill
                      loading={index < 3 ? 'eager' : 'lazy'}
                      sizes='(max-width: 640px) 45vw, (max-width: 1024px) 28vw, 16vw'
                      className='object-cover'
                    />
                  ) : (
                    <div className='from-base-200 to-base-300 flex h-full flex-col items-center justify-center bg-gradient-to-br p-5 text-center'>
                      <PiBookOpenText className='text-base-content/30 h-9 w-9' aria-hidden='true' />
                      <span className='text-base-content/70 mt-4 line-clamp-4 font-serif text-sm font-medium'>
                        {book.title}
                      </span>
                    </div>
                  )}
                </div>
                <h2 className='mt-4 line-clamp-2 text-sm font-semibold leading-snug'>
                  {book.title}
                </h2>
                {book.author && (
                  <p className='text-base-content/55 mt-1 line-clamp-2 text-xs leading-relaxed'>
                    {book.author}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <footer className='border-base-300/70 border-t'>
        <div className='text-base-content/55 mx-auto flex max-w-7xl flex-col gap-2 px-5 py-7 text-xs sm:flex-row sm:items-center sm:justify-between sm:px-8'>
          <span>{brandName} is a self-hosted build based on Readest.</span>
          <a
            href={sourceCodeUrl}
            target='_blank'
            rel='noreferrer'
            className='underline underline-offset-4'
          >
            Source code · AGPL-3.0
          </a>
        </div>
      </footer>
    </main>
  );
}
