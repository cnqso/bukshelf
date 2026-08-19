export interface ReadestRuntimeConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  apiBaseUrl?: string;
  objectStorageType?: string;
  storageFixedQuota?: number;
  translationFixedQuota?: number;
  selfHostedPremiumFeatures?: boolean;
  privacyMode?: boolean;
  openRouterServerEnabled?: boolean;
  openRouterChatModel?: string;
  openRouterEmbeddingModel?: string;
  fontBaseUrl?: string;
}

declare global {
  interface Window {
    __READEST_RUNTIME_CONFIG?: ReadestRuntimeConfig;
  }
}

export const getRuntimeConfig = () =>
  typeof window === 'undefined' ? undefined : window.__READEST_RUNTIME_CONFIG;

export const getServerRuntimeConfig = (): ReadestRuntimeConfig => ({
  // Browser runtime config should prefer a public Supabase URL when provided.
  // SUPABASE_URL remains as a backward-compatible fallback for non-split setups.
  supabaseUrl:
    process.env['SUPABASE_PUBLIC_URL'] ??
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ??
    process.env['SUPABASE_URL'],
  supabaseAnonKey: process.env['SUPABASE_ANON_KEY'] ?? process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'],
  apiBaseUrl:
    process.env['API_BASE_URL'] ??
    process.env['NEXT_PUBLIC_API_BASE_URL'] ??
    process.env['SITE_URL'],
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
  // The browser only needs to know whether the server has OpenRouter and
  // which fixed models it will use. The API key remains server-only.
  openRouterServerEnabled: Boolean(process.env['OPENROUTER_API_KEY']),
  openRouterChatModel: process.env['OPENROUTER_CHAT_MODEL'] || 'google/gemini-3.6-flash',
  openRouterEmbeddingModel:
    process.env['OPENROUTER_EMBEDDING_MODEL'] || 'openai/text-embedding-3-small',
  // Base URL of the directory holding the self-hosted CJK webfont bundles.
  // Readest's own CDN only answers CORS for readest.com origins, so a
  // self-hosted deployment on a custom domain has to serve them itself (#5550).
  // `||` not `??`: compose passes the variable through even when it is unset,
  // and an empty string would build root-relative font URLs.
  fontBaseUrl:
    process.env['FONT_BASE_URL'] || process.env['NEXT_PUBLIC_FONT_BASE_URL'] || undefined,
});
