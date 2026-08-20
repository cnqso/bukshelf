import { createHash } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SQL } from 'bun';

export interface PublicLibraryBook {
  id: string;
  title: string;
  author: string | null;
  coverUrl: string | null;
}

export interface PublicCover {
  body: Uint8Array;
  contentType?: string;
}

export interface PublicLibraryService {
  listBooks(): Promise<PublicLibraryBook[]>;
  getCover(fileId: string): Promise<PublicCover | null>;
}

interface LegacyLibraryConfig {
  databaseUrl: string;
  ownerEmail: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
}

const isCoverKey = (fileKey: string): boolean => /\/cover\.(png|jpe?g|webp|gif)$/i.test(fileKey);

export const createLegacyPublicLibrary = (config: LegacyLibraryConfig): PublicLibraryService => {
  const database = new SQL(config.databaseUrl);
  const storage = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
    },
  });

  const findOwnerId = async (): Promise<string | null> => {
    const rows = await database`
      SELECT id
      FROM auth.users
      WHERE lower(email) = lower(${config.ownerEmail})
      LIMIT 1
    `;
    return rows[0]?.id ?? null;
  };

  return {
    async listBooks() {
      const ownerId = await findOwnerId();
      if (!ownerId) return [];

      const rows = await database`
        SELECT
          b.book_hash,
          b.title,
          b.source_title,
          b.author,
          f.id AS cover_id
        FROM public.books b
        LEFT JOIN LATERAL (
          SELECT id
          FROM public.files
          WHERE user_id = b.user_id
            AND book_hash = b.book_hash
            AND deleted_at IS NULL
            AND file_key ~* '/cover\\.(png|jpe?g|webp|gif)$'
          ORDER BY updated_at DESC
          LIMIT 1
        ) f ON true
        WHERE b.user_id = ${ownerId}
          AND b.deleted_at IS NULL
        ORDER BY b.updated_at DESC
      `;

      return rows.map((book) => ({
        id: createHash('sha256').update(book.book_hash).digest('hex').slice(0, 24),
        title: book.title?.trim() || book.source_title?.trim() || 'Untitled',
        author: book.author?.trim() || null,
        coverUrl: book.cover_id ? `/api/public/library/covers/${book.cover_id}` : null,
      }));
    },

    async getCover(fileId) {
      const ownerId = await findOwnerId();
      if (!ownerId) return null;

      const rows = await database`
        SELECT f.file_key
        FROM public.files f
        INNER JOIN public.books b
          ON b.user_id = f.user_id
          AND b.book_hash = f.book_hash
          AND b.deleted_at IS NULL
        WHERE f.id = ${fileId}
          AND f.user_id = ${ownerId}
          AND f.deleted_at IS NULL
        LIMIT 1
      `;
      const fileKey = rows[0]?.file_key;
      if (!fileKey || !isCoverKey(fileKey)) return null;

      const object = await storage.send(
        new GetObjectCommand({ Bucket: config.s3Bucket, Key: fileKey }),
      );
      if (!object.Body) throw new Error('Cover object body is empty');
      return {
        body: await object.Body.transformToByteArray(),
        contentType: object.ContentType,
      };
    },
  };
};
