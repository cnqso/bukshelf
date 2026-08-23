export interface ReadestRuntimeConfig {
  brandName?: string;
  publicLibraryEnabled?: boolean;
  sourceCodeUrl?: string;
  apiBaseUrl?: string;
  bukshelfApiBaseUrl?: string;
  bukshelfAuthEnabled?: boolean;
  objectStorageType?: string;
  storageFixedQuota?: number;
  translationFixedQuota?: number;
  selfHostedPremiumFeatures?: boolean;
  privacyMode?: boolean;
  sonioxServerEnabled?: boolean;
  openRouterServerEnabled?: boolean;
  openRouterChatModel?: string;
  fontBaseUrl?: string;
}

declare global {
  interface Window {
    __READEST_RUNTIME_CONFIG?: ReadestRuntimeConfig;
  }
}

export const getRuntimeConfig = () =>
  typeof window === 'undefined' ? undefined : window.__READEST_RUNTIME_CONFIG;

export const getBrandName = () =>
  typeof window === 'undefined'
    ? process.env['SELF_HOSTED_BRAND_NAME'] || 'Readest'
    : getRuntimeConfig()?.brandName || (isMobileTauriClient() ? 'Bukshelf' : 'Readest');

export const getSourceCodeUrl = () =>
  typeof window === 'undefined'
    ? process.env['SELF_HOSTED_SOURCE_URL'] || 'https://github.com/readest/readest'
    : getRuntimeConfig()?.sourceCodeUrl || 'https://github.com/readest/readest';

export const getBukshelfApiBaseUrl = () =>
  (
    (typeof window === 'undefined'
      ? process.env['BUKSHELF_API_PUBLIC_URL']
      : isMobileTauriClient()
        ? getSelectedBukshelfServerUrl()
        : getRuntimeConfig()?.bukshelfApiBaseUrl) || ''
  ).replace(/\/$/, '');

export const isBukshelfAuthEnabled = () =>
  typeof window === 'undefined'
    ? process.env['BUKSHELF_AUTH_ENABLED']?.toLowerCase() === 'true'
    : isMobileTauriClient() || getRuntimeConfig()?.bukshelfAuthEnabled === true;

export const getServerRuntimeConfig = (): ReadestRuntimeConfig => ({
  brandName: process.env['SELF_HOSTED_BRAND_NAME'] || 'Readest',
  publicLibraryEnabled: process.env['SELF_HOSTED_PUBLIC_LIBRARY']?.toLowerCase() === 'true',
  sourceCodeUrl: process.env['SELF_HOSTED_SOURCE_URL'] || 'https://github.com/readest/readest',
  apiBaseUrl:
    process.env['API_BASE_URL'] ??
    process.env['NEXT_PUBLIC_API_BASE_URL'] ??
    process.env['SITE_URL'],
  // Unified self-hosting serves the frontend and Bun API on one origin.
  bukshelfApiBaseUrl: process.env['BUKSHELF_API_PUBLIC_URL'] ?? process.env['SITE_URL'],
  bukshelfAuthEnabled: process.env['BUKSHELF_AUTH_ENABLED']?.toLowerCase() === 'true',
  // These were previously baked as NEXT_PUBLIC_* build args; now read from runtime env so
  // the published image can be configured without rebuilding.
  objectStorageType:
    process.env['OBJECT_STORAGE_TYPE'] ?? process.env['NEXT_PUBLIC_OBJECT_STORAGE_TYPE'],
  storageFixedQuota: (() => {
    const raw =
      process.env['STORAGE_FIXED_QUOTA'] ?? process.env['NEXT_PUBLIC_STORAGE_FIXED_QUOTA'];
    return raw ? parseInt(raw, 10) : undefined;
  })(),
  translationFixedQuota: (() => {
    const raw =
      process.env['TRANSLATION_FIXED_QUOTA'] ?? process.env['NEXT_PUBLIC_TRANSLATION_FIXED_QUOTA'];
    return raw ? parseInt(raw, 10) : undefined;
  })(),
  // Self-hosters provide their own storage, TTS and third-party sync backends,
  // so they can opt out of Readest Cloud's client-side plan gates. This does
  // not enable hosted infrastructure such as the inbound-email Worker.
  selfHostedPremiumFeatures: process.env['SELF_HOSTED_PREMIUM_FEATURES']?.toLowerCase() === 'true',
  // Privacy mode is intentionally exposed as a boolean only. It disables
  // product analytics in the web client without weakening sign-in or sync.
  privacyMode: process.env['SELF_HOSTED_PRIVACY_MODE']?.toLowerCase() === 'true',
  sonioxServerEnabled: Boolean(process.env['SONIOX_API_KEY']),
  // The browser only needs to know whether the server has OpenRouter and
  // which fixed models it will use. The API key remains server-only.
  openRouterServerEnabled: Boolean(process.env['OPENROUTER_API_KEY']),
  openRouterChatModel: process.env['OPENROUTER_CHAT_MODEL'] || 'google/gemini-3.6-flash',
  // Base URL of the directory holding the self-hosted CJK webfont bundles.
  // Readest's own CDN only answers CORS for readest.com origins, so a
  // self-hosted deployment on a custom domain has to serve them itself (#5550).
  // `||` not `??`: compose passes the variable through even when it is unset,
  // and an empty string would build root-relative font URLs.
  fontBaseUrl:
    process.env['FONT_BASE_URL'] || process.env['NEXT_PUBLIC_FONT_BASE_URL'] || undefined,
});
import { getSelectedBukshelfServerUrl, isMobileTauriClient } from './mobileServer';
