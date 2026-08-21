import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createGateway, streamText } from 'ai';
import type { ModelMessage } from 'ai';
import { estimateOpenRouterTokens, openRouterUsageMeter } from '@/services/ai/openRouterUsageMeter';
import { validateUserAndToken } from '@/utils/access';

const maxRequestCharacters = () => {
  const configured = Number.parseInt(process.env['OPENROUTER_MAX_INPUT_CHARACTERS'] || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 900_000;
};

export async function GET(req: Request): Promise<Response> {
  const { user, token } = await validateUserAndToken(req.headers.get('authorization'));
  if (!user || !token) return Response.json({ error: 'Not authenticated' }, { status: 403 });
  if (!process.env['OPENROUTER_API_KEY']) {
    return Response.json({ error: 'Server-managed OpenRouter is not configured' }, { status: 503 });
  }
  return Response.json({
    model: process.env['OPENROUTER_CHAT_MODEL'] || 'google/gemini-3.6-flash',
    usage: openRouterUsageMeter.snapshot(),
  });
}

export async function POST(req: Request): Promise<Response> {
  const { user, token } = await validateUserAndToken(req.headers.get('authorization'));
  if (!user || !token) return Response.json({ error: 'Not authenticated' }, { status: 403 });

  try {
    const body = (await req.json()) as {
      messages?: ModelMessage[];
      system?: string;
      apiKey?: string;
      model?: string;
      provider?: 'ai-gateway' | 'openrouter';
    };
    if (!Array.isArray(body.messages)) {
      return Response.json({ error: 'Messages required' }, { status: 400 });
    }

    const serializedPrompt = `${body.system ?? ''}\n${JSON.stringify(body.messages)}`;
    if (serializedPrompt.length > maxRequestCharacters()) {
      return Response.json({ error: 'AI request is too large' }, { status: 413 });
    }

    if (body.provider !== 'openrouter') {
      const gatewayApiKey = body.apiKey || process.env['AI_GATEWAY_API_KEY'];
      if (!gatewayApiKey) return Response.json({ error: 'API key required' }, { status: 401 });
      const gateway = createGateway({ apiKey: gatewayApiKey });
      const result = streamText({
        model: gateway(body.model || 'google/gemini-2.5-flash-lite'),
        system: body.system || 'You are a helpful assistant.',
        messages: body.messages,
      });
      return result.toTextStreamResponse();
    }

    const apiKey = process.env['OPENROUTER_API_KEY'];
    if (!apiKey) {
      return Response.json(
        { error: 'Server-managed OpenRouter is not configured' },
        { status: 503 },
      );
    }

    const requestId = crypto.randomUUID();
    const userId = String(user.id);
    const model = process.env['OPENROUTER_CHAT_MODEL'] || 'google/gemini-3.6-flash';
    const estimatedInputTokens = estimateOpenRouterTokens(serializedPrompt);
    const metering = openRouterUsageMeter.acquire(estimatedInputTokens);
    if (!metering.accepted) {
      console.warn(
        JSON.stringify({
          service: 'openrouter_ai',
          event: 'rejected',
          kind: 'chat',
          requestId,
          userId,
          model,
          estimatedInputTokens,
          reason: metering.reason,
          usage: metering.snapshot,
        }),
      );
      return Response.json(
        { error: 'Reader AI usage limit reached', type: metering.reason },
        { status: 429, headers: { 'Retry-After': String(metering.retryAfterSeconds) } },
      );
    }

    const startedAt = Date.now();
    let finished = false;
    const finish = (usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }) => {
      if (finished) return;
      finished = true;
      console.info(
        JSON.stringify({
          service: 'openrouter_ai',
          event: 'completed',
          kind: 'chat',
          requestId,
          userId,
          model,
          durationMs: Date.now() - startedAt,
          estimatedInputTokens,
          providerUsage: usage,
          usage: openRouterUsageMeter.finish(metering.lease, usage),
        }),
      );
    };
    console.info(
      JSON.stringify({
        service: 'openrouter_ai',
        event: 'started',
        kind: 'chat',
        requestId,
        userId,
        model,
        estimatedInputTokens,
        usage: metering.snapshot,
      }),
    );

    const openrouter = createOpenAICompatible({
      name: 'openrouter',
      baseURL: process.env['OPENROUTER_BASE_URL'] || 'https://openrouter.ai/api/v1',
      apiKey,
      headers: {
        'HTTP-Referer': process.env['SITE_URL'] || 'http://localhost:3000',
        'X-Title': `${process.env['SELF_HOSTED_BRAND_NAME'] || 'Readest'} Self-Hosted`,
      },
    });
    const result = streamText({
      model: openrouter.chatModel(model),
      system: body.system || 'You are a helpful reading assistant.',
      messages: body.messages,
      maxOutputTokens: Number.parseInt(process.env['OPENROUTER_MAX_OUTPUT_TOKENS'] || '2048', 10),
      onFinish: ({ totalUsage }) => finish(totalUsage),
      onError: ({ error }) => {
        console.error(
          JSON.stringify({
            service: 'openrouter_ai',
            event: 'upstream_error',
            kind: 'chat',
            requestId,
            userId,
            model,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        finish();
      },
      onAbort: () => finish(),
    });
    return result.toTextStreamResponse({ headers: { 'X-Request-Id': requestId } });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: `Chat failed: ${errorMessage}` }, { status: 500 });
  }
}
