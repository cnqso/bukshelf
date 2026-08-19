import { createHash } from 'node:crypto';
import { createSupabaseAdminClient } from '@/utils/supabase';

export interface PublicLibraryBook {
  id: string;
  title: string;
  author: string | null;
  coverUrl: string | null;
}

const PUBLIC_LIBRARY_CACHE_MS = 30_000;

let ownerCache: { email: string; userId: string; expiresAt: number } | null = null;

export const isPublicLibraryEnabled = () =>
  process.env['SELF_HOSTED_PUBLIC_LIBRARY']?.toLowerCase() === 'true';

export const getPublicLibraryOwnerId = async (): Promise<string | null> => {
  const ownerEmail = process.env['SELF_HOSTED_OWNER_EMAIL']?.trim().toLowerCase();
  if (!isPublicLibraryEnabled() || !ownerEmail) return null;

  if (ownerCache && ownerCache.email === ownerEmail && ownerCache.expiresAt > Date.now()) {
    return ownerCache.userId;
  }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1_000 });
  if (error) throw error;

  const owner = data.users.find((user) => user.email?.toLowerCase() === ownerEmail);
  if (!owner) return null;

  ownerCache = {
    email: ownerEmail,
    userId: owner.id,
    expiresAt: Date.now() + PUBLIC_LIBRARY_CACHE_MS,
  };
  return owner.id;
};

const isCoverKey = (fileKey: string): boolean => /\/cover\.(png|jpe?g|webp|gif)$/i.test(fileKey);

export const getPublicLibraryBooks = async (): Promise<PublicLibraryBook[]> => {
  const ownerId = await getPublicLibraryOwnerId();
  if (!ownerId) return [];

  const supabase = createSupabaseAdminClient();
  const [{ data: books, error: booksError }, { data: files, error: filesError }] =
    await Promise.all([
      supabase
        .from('books')
        .select('book_hash, title, source_title, author, updated_at')
        .eq('user_id', ownerId)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false }),
      supabase
        .from('files')
        .select('id, book_hash, file_key')
        .eq('user_id', ownerId)
        .is('deleted_at', null),
    ]);

  if (booksError) throw booksError;
  if (filesError) throw filesError;

  const coverIdByBookHash = new Map<string, string>();
  for (const file of files ?? []) {
    if (file.book_hash && isCoverKey(file.file_key)) {
      coverIdByBookHash.set(file.book_hash, file.id);
    }
  }

  return (books ?? []).map((book) => {
    const coverId = coverIdByBookHash.get(book.book_hash);
    return {
      id: createHash('sha256').update(book.book_hash).digest('hex').slice(0, 24),
      title: book.title?.trim() || book.source_title?.trim() || 'Untitled',
      author: book.author?.trim() || null,
      coverUrl: coverId ? `/api/public/library/covers/${coverId}` : null,
    };
  });
};

export const getPublicCoverFileKey = async (fileId: string): Promise<string | null> => {
  const ownerId = await getPublicLibraryOwnerId();
  if (!ownerId) return null;

  const supabase = createSupabaseAdminClient();
  const { data: file, error: fileError } = await supabase
    .from('files')
    .select('book_hash, file_key')
    .eq('id', fileId)
    .eq('user_id', ownerId)
    .is('deleted_at', null)
    .maybeSingle();

  if (fileError) throw fileError;
  if (!file?.book_hash || !isCoverKey(file.file_key)) return null;

  const { data: book, error: bookError } = await supabase
    .from('books')
    .select('book_hash')
    .eq('user_id', ownerId)
    .eq('book_hash', file.book_hash)
    .is('deleted_at', null)
    .maybeSingle();

  if (bookError) throw bookError;
  return book ? file.file_key : null;
};
