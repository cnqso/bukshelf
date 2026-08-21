import { createGateway } from 'ai';
import type { LanguageModel } from 'ai';
import type { AIProvider, AISettings, AIProviderName } from '../types';
import { aiLogger } from '../logger';
import { GATEWAY_MODELS } from '../constants';
import { AI_TIMEOUTS } from '../utils/retry';
import { getAIFetch } from '../utils/httpFetch';
import { getBukshelfApiBaseUrl } from '@/services/runtimeConfig';
import { bukshelfProviderUrl } from '@/utils/fetch';
import { getAccessToken } from '@/utils/access';

const AI_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1';

export class AIGatewayProvider implements AIProvider {
  id: AIProviderName = 'ai-gateway';
  name = 'AI Gateway (Cloud)';
  requiresAuth = true;

  private settings: AISettings;
  private gateway: ReturnType<typeof createGateway>;

  constructor(settings: AISettings) {
    this.settings = settings;
    if (!settings.aiGatewayApiKey) {
      throw new Error('AI Gateway API key required');
    }
    this.gateway = createGateway({ apiKey: settings.aiGatewayApiKey });
    aiLogger.provider.init(
      'ai-gateway',
      settings.aiGatewayModel || GATEWAY_MODELS.GEMINI_FLASH_LITE,
    );
  }

  getModel(): LanguageModel {
    const modelId = this.settings.aiGatewayModel || GATEWAY_MODELS.GEMINI_FLASH_LITE;
    return this.gateway(modelId);
  }

  async isAvailable(): Promise<boolean> {
    return !!this.settings.aiGatewayApiKey;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.settings.aiGatewayApiKey) return false;

    try {
      const modelId = this.settings.aiGatewayModel || GATEWAY_MODELS.GEMINI_FLASH_LITE;
      aiLogger.provider.init('ai-gateway', `healthCheck starting with model: ${modelId}`);

      // With Bukshelf configured, chat is proxied through its /api/ai/chat
      // route; probe that. Otherwise probe the gateway's OpenAI-compatible
      // models endpoint directly — never the legacy Next.js API routes.
      const bukshelfBase = getBukshelfApiBaseUrl();
      const response = bukshelfBase
        ? await fetch(`${bukshelfProviderUrl('/api/ai/chat')}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${await getAccessToken()}`,
            },
            body: JSON.stringify({
              messages: [{ role: 'user', content: 'hi' }],
              apiKey: this.settings.aiGatewayApiKey,
              model: modelId,
            }),
            signal: AbortSignal.timeout(AI_TIMEOUTS.HEALTH_CHECK),
          })
        : await getAIFetch()(`${AI_GATEWAY_BASE_URL}/models`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${this.settings.aiGatewayApiKey}` },
            signal: AbortSignal.timeout(AI_TIMEOUTS.HEALTH_CHECK),
          });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || `Health check failed: ${response.status}`);
      }

      aiLogger.provider.init('ai-gateway', 'healthCheck success');
      return true;
    } catch (e) {
      const error = e as Error;
      aiLogger.provider.error('ai-gateway', `healthCheck failed: ${error.message}`);
      return false;
    }
  }
}
