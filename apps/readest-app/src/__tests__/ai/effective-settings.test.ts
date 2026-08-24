import { describe, expect, test } from 'vitest';
import { DEFAULT_AI_SETTINGS } from '@/services/ai/constants';
import { getEffectiveAISettings } from '@/services/ai/effectiveSettings';

describe('getEffectiveAISettings', () => {
  test('forces a late-discovered server-managed OpenRouter provider on', () => {
    const saved = {
      ...DEFAULT_AI_SETTINGS,
      enabled: false,
      provider: 'ollama' as const,
      openrouterApiKey: 'stale-client-key',
      spoilerProtection: false,
    };

    expect(getEffectiveAISettings(saved, undefined)).toEqual(saved);
    expect(
      getEffectiveAISettings(saved, {
        openRouterServerEnabled: true,
        openRouterChatModel: 'google/gemini-3.6-flash',
      }),
    ).toEqual({
      ...saved,
      enabled: true,
      provider: 'openrouter',
      openrouterApiKey: undefined,
      openrouterModel: 'google/gemini-3.6-flash',
    });
  });

  test('preserves the saved model when discovery does not advertise one', () => {
    const saved = {
      ...DEFAULT_AI_SETTINGS,
      enabled: false,
      provider: 'ollama' as const,
      openrouterModel: 'google/gemini-3.6-flash',
    };

    expect(getEffectiveAISettings(saved, { openRouterServerEnabled: true })).toMatchObject({
      enabled: true,
      provider: 'openrouter',
      openrouterModel: 'google/gemini-3.6-flash',
    });
  });
});
