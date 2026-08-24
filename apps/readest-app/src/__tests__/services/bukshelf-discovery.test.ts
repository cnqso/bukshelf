import { afterEach, describe, expect, test, vi } from 'vitest';
import { discoverBukshelfServer } from '@/services/bukshelfDiscovery';
import { getRuntimeConfig, setRuntimeConfig } from '@/services/runtimeConfig';

describe('Bukshelf capability discovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setRuntimeConfig(undefined);
  });

  test('maps server capabilities into the native runtime config', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          capabilities: { readerAI: true, textToSpeech: true },
          models: { readerAI: 'google/gemini-3.6-flash' },
        }),
      ),
    );

    await discoverBukshelfServer('https://books.example.test');

    expect(fetch).toHaveBeenCalledWith('https://books.example.test/.well-known/bukshelf');
    expect(getRuntimeConfig()).toMatchObject({
      openRouterServerEnabled: true,
      openRouterChatModel: 'google/gemini-3.6-flash',
      sonioxServerEnabled: true,
    });
  });
});
