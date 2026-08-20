export interface ImageType {
  contentType: string;
  extension: string;
}

const GIF_HEADER = /^GIF8[79]a$/;

/**
 * Sniffs the cover formats Bukshelf accepts. Filenames are never trusted: the
 * legacy stack stores JPEG bytes under `cover.png`, and the public API must
 * report the type the bytes actually are.
 */
export const detectImageType = (body: Uint8Array): ImageType | null => {
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff)
    return { contentType: 'image/jpeg', extension: 'jpg' };
  if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47)
    return { contentType: 'image/png', extension: 'png' };
  if (
    body[0] === 0x52 &&
    body[1] === 0x49 &&
    body[2] === 0x46 &&
    body[3] === 0x46 &&
    body[8] === 0x57 &&
    body[9] === 0x45 &&
    body[10] === 0x42 &&
    body[11] === 0x50
  )
    return { contentType: 'image/webp', extension: 'webp' };
  if (GIF_HEADER.test(new TextDecoder().decode(body.slice(0, 6))))
    return { contentType: 'image/gif', extension: 'gif' };
  return null;
};

export const COVER_EXTENSIONS = ['jpg', 'png', 'webp', 'gif'] as const;

export type CoverExtension = (typeof COVER_EXTENSIONS)[number];

const CONTENT_TYPE_BY_EXTENSION: Record<CoverExtension, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

export const coverContentType = (extension: string): string | undefined =>
  CONTENT_TYPE_BY_EXTENSION[extension as CoverExtension];
