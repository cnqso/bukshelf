import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { NextResponse } from 'next/server';
import { createGateway, embed, embedMany } from 'ai';
import { estimateOpenRouterTokens, openRouterUsageMeter } from '@/services/ai/openRouterUsageMeter';
import { validateUserAndToken } from '@/utils/access';

export async function POST(req: Request): Promise<Response> {
  const { user, token } = await validateUserAndToken(req.headers.get('authorization'));
  if (!user || !token) return NextResponse.json({ error: 'Not authenticated' }, { status: 403 });

  try {
    const body = (await req.json()) as {
      texts?: string[];
      single?: boolean;
      apiKey?: string;
      provider?: 'ai-gateway' | 'openrouter';
    };
    if (
      !Array.isArray(body.texts) ||
      body.texts.length === 0 ||
      body.texts.some((text) => typeof text !== 'string')
    ) {
      return NextResponse.json({ error: 'Texts array required' }, { status: 400 });
    }
    const totalCharacters = body.texts.reduce((sum, text) => sum + text.length, 0);
    if (body.texts.length > 100 || totalCharacters > 500_000) {
      return NextResponse.json({ error: 'Embedding request is too large' }, { status: 413 });
    }

    if (body.provider !== 'openrouter') {
      const gatewayApiKey = body.apiKey || process.env['AI_GATEWAY_API_KEY'];
      if (!gatewayApiKey) {
        return NextResponse.json({ error: 'API key required' }, { status: 401 });
      }
      const gateway = createGateway({ apiKey: gatewayApiKey });
      const model = gateway.embeddingModel(
        process.env['AI_GATEWAY_EMBEDDING_MODEL'] || 'openai/text-embedding-3-small',
      );
      const result = body.single
        ? await embed({ model, value: body.texts[0]! })
        : await embedMany({ model, values: body.texts });
      return NextResponse.json(
        'embedding' in result ? { embedding: result.embedding } : { embeddings: result.embeddings },
      );
    }

    const apiKey = process.env['OPENROUTER_API_KEY'];
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Server-managed OpenRouter is not configured' },
        { status: 503 },
      );
    }
    const requestId = crypto.randomUUID();
    const userId = String(user.id);
    const modelId = process.env['OPENROUTER_EMBEDDING_MODEL'] || 'openai/text-embedding-3-small';
    const estimatedInputTokens = estimateOpenRouterTokens(body.texts.join('\n'));
    const metering = openRouterUsageMeter.acquire(estimatedInputTokens);
    if (!metering.accepted) {
      console.warn(
        JSON.stringify({
          service: 'openrouter_ai',
          event: 'rejected',
          kind: 'embedding',
          requestId,
          userId,
          model: modelId,
          estimatedInputTokens,
          reason: metering.reason,
          usage: metering.snapshot,
        }),
      );
      return NextResponse.json(
        { error: 'Reader AI usage limit reached', type: metering.reason },
        { status: 429, headers: { 'Retry-After': String(metering.retryAfterSeconds) } },
      );
    }

    const startedAt = Date.now();
    console.info(
      JSON.stringify({
        service: 'openrouter_ai',
        event: 'started',
        kind: 'embedding',
        requestId,
        userId,
        model: modelId,
        texts: body.texts.length,
        characters: totalCharacters,
        estimatedInputTokens,
        usage: metering.snapshot,
      }),
    );
    try {
      const openrouter = createOpenAICompatible({
        name: 'openrouter',
        baseURL: process.env['OPENROUTER_BASE_URL'] || 'https://openrouter.ai/api/v1',
        apiKey,
      });
      const model = openrouter.textEmbeddingModel(modelId);
      const result = body.single
        ? await embed({ model, value: body.texts[0]! })
        : await embedMany({ model, values: body.texts });
      const usage = result.usage;
      console.info(
        JSON.stringify({
          service: 'openrouter_ai',
          event: 'completed',
          kind: 'embedding',
          requestId,
          userId,
          model: modelId,
          durationMs: Date.now() - startedAt,
          providerUsage: usage,
          usage: openRouterUsageMeter.finish(metering.lease, {
            inputTokens: usage.tokens,
            totalTokens: usage.tokens,
          }),
        }),
      );
      return NextResponse.json(
        'embedding' in result ? { embedding: result.embedding } : { embeddings: result.embeddings },
      );
    } catch (error) {
      openRouterUsageMeter.finish(metering.lease);
      console.error(
        JSON.stringify({
          service: 'openrouter_ai',
          event: 'upstream_error',
          kind: 'embedding',
          requestId,
          userId,
          model: modelId,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: `Embedding failed: ${errorMessage}` }, { status: 500 });
  }
}
