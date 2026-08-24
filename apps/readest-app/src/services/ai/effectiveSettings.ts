import { getRuntimeConfig, type ReadestRuntimeConfig } from '@/services/runtimeConfig';
import { DEFAULT_AI_SETTINGS } from './constants';
import type { AISettings } from './types';

export const getEffectiveAISettings = (
  settings?: AISettings,
  runtimeConfig: ReadestRuntimeConfig | undefined = getRuntimeConfig(),
): AISettings => {
  const effective = { ...DEFAULT_AI_SETTINGS, ...settings };
  if (!runtimeConfig?.openRouterServerEnabled) return effective;
  return {
    ...effective,
    enabled: true,
    provider: 'openrouter',
    openrouterApiKey: undefined,
    ...(runtimeConfig.openRouterChatModel
      ? { openrouterModel: runtimeConfig.openRouterChatModel }
      : {}),
  };
};
