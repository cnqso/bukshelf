import type { MetadataRoute } from 'next';

export const dynamic = 'force-dynamic';

export default function manifest(): MetadataRoute.Manifest {
  const brandName = process.env['SELF_HOSTED_BRAND_NAME'] || 'Readest';
  const icon = brandName === 'Readest' ? '/icon.png' : '/bukshelf-icon.svg';
  return {
    name: brandName,
    short_name: brandName,
    start_url: '/',
    display: 'standalone',
    background_color: '#f7f5f0',
    theme_color: '#171717',
    description: `${brandName} is a private, self-hosted ebook library.`,
    icons: [
      {
        src: icon,
        type: icon.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        sizes: 'any',
      },
    ],
  };
}
