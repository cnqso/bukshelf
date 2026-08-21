import { streamText } from 'ai';
import type { ChatModelAdapter, ChatModelRunResult } from '@assistant-ui/react';
import { getAIProvider } from '../providers';
import { aiLogger } from '../logger';
import { buildSystemPrompt } from '../prompts';
import type { AISettings } from '../types';
import { getRuntimeConfig } from '@/services/runtimeConfig';
import { fetchWithAuth } from '@/utils/fetch';

export interface TauriAdapterOptions {
  settings: AISettings;
  bookTitle: string;
  authorName: string;
  currentPage: number;
  bookContext: string;
  contextTruncated: boolean;
}

async function* streamViaApiRoute(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
  settings: AISettings,
  abortSignal?: AbortSignal,
): AsyncGenerator<string> {
  const response = await fetchWithAuth('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      system: systemPrompt,
      provider: settings.provider,
      apiKey: settings.provider === 'ai-gateway' ? settings.aiGatewayApiKey : undefined,
      model:
        settings.provider === 'ai-gateway'
          ? settings.aiGatewayModel || 'google/gemini-2.5-flash-lite'
          : undefined,
    }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({ error: 'Unknown error' }))) as {
      error?: string;
    };
    throw new Error(error.error || `Chat failed: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Chat response contained no stream');
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
}

export function createTauriAdapter(getOptions: () => TauriAdapterOptions): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }): AsyncGenerator<ChatModelRunResult> {
      const { settings, bookTitle, authorName, currentPage, bookContext, contextTruncated } =
        getOptions();
      const aiMessages = messages.map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n'),
      }));
      const query =
        [...aiMessages].reverse().find((message) => message.role === 'user')?.content ?? '';
      const systemPrompt = buildSystemPrompt(
        bookTitle,
        authorName,
        bookContext,
        currentPage,
        contextTruncated,
        settings.spoilerProtection,
      );
      const useApiRoute =
        typeof window !== 'undefined' &&
        (settings.provider === 'ai-gateway' ||
          (settings.provider === 'openrouter' &&
            getRuntimeConfig()?.openRouterServerEnabled === true));

      aiLogger.chat.send(query.length, bookContext.length);
      try {
        let text = '';
        if (useApiRoute) {
          for await (const chunk of streamViaApiRoute(
            aiMessages,
            systemPrompt,
            settings,
            abortSignal,
          )) {
            text += chunk;
            yield { content: [{ type: 'text', text }] };
          }
        } else {
          const result = streamText({
            model: getAIProvider(settings).getModel(),
            system: systemPrompt,
            messages: aiMessages,
            abortSignal,
          });
          for await (const chunk of result.textStream) {
            text += chunk;
            yield { content: [{ type: 'text', text }] };
          }
        }
        aiLogger.chat.complete(text.length);
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          aiLogger.chat.error((error as Error).message);
          throw error;
        }
      }
    },
  };
}
