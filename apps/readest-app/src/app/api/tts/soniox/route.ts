import { NextRequest, NextResponse } from 'next/server';
import { validateUserAndToken } from '@/utils/access';
import { estimateSonioxTokens, sonioxUsageMeter } from '@/services/tts/sonioxUsageMeter';

const SONIOX_TTS_URL = 'https://tts-rt.soniox.com/tts';
const SONIOX_MODEL = 'tts-rt-v2';
const SONIOX_VOICE = 'Kayla';
const MAX_TEXT_LENGTH = 5000;

const unavailable = () =>
  NextResponse.json(
    { error: { message: 'Soniox TTS is not configured', type: 'service_unavailable' } },
    { status: 503 },
  );

const primaryLanguage = (lang: string): string | null => {
  const primary = lang.trim().split(/[-_]/, 1)[0]?.toLowerCase() ?? '';
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
};

export async function GET(request: NextRequest) {
  const { user, token } = await validateUserAndToken(request.headers.get('authorization'));
  if (!user || !token) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 403 });
  }
  if (!process.env['SONIOX_API_KEY']) return unavailable();

  return NextResponse.json({
    model: SONIOX_MODEL,
    voices: [{ id: SONIOX_VOICE, name: SONIOX_VOICE, language: 'en' }],
    usage: sonioxUsageMeter.snapshot(),
  });
}

export async function POST(request: NextRequest) {
  const { user, token } = await validateUserAndToken(request.headers.get('authorization'));
  if (!user || !token) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 403 });
  }

  const apiKey = process.env['SONIOX_API_KEY'];
  if (!apiKey) return unavailable();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json(
      { error: { message: 'Invalid request body', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  const input = 'input' in body ? body.input : null;
  const voice = 'voice' in body ? body.voice : null;
  const lang = 'lang' in body ? body.lang : null;
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      {
        error: {
          message: `"input" must contain between 1 and ${MAX_TEXT_LENGTH} characters`,
          type: 'invalid_request_error',
        },
      },
      { status: 400 },
    );
  }
  if (voice !== SONIOX_VOICE) {
    return NextResponse.json(
      { error: { message: `Voice must be "${SONIOX_VOICE}"`, type: 'invalid_request_error' } },
      { status: 400 },
    );
  }
  const language = typeof lang === 'string' ? primaryLanguage(lang) : null;
  if (!language) {
    return NextResponse.json(
      { error: { message: 'Invalid "lang" field', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  const requestId = crypto.randomUUID();
  const userId = String(user.id);
  const characters = input.length;
  const estimatedTokens = estimateSonioxTokens(input);
  const metering = sonioxUsageMeter.begin({ userId, characters, estimatedTokens });
  if (!metering.accepted) {
    console.warn(
      JSON.stringify({
        service: 'soniox_tts',
        event: 'rejected',
        requestId,
        userId,
        model: SONIOX_MODEL,
        voice: SONIOX_VOICE,
        language,
        characters,
        estimatedTokens,
        reason: metering.reason,
        retryAfterSeconds: metering.retryAfterSeconds,
        usage: metering.snapshot,
      }),
    );
    return NextResponse.json(
      {
        error: {
          message: 'Soniox TTS usage limit reached',
          type: metering.reason,
          retryAfterSeconds: metering.retryAfterSeconds,
        },
      },
      { status: 429, headers: { 'Retry-After': String(metering.retryAfterSeconds) } },
    );
  }

  const startedAt = Date.now();
  const logBase = {
    service: 'soniox_tts',
    requestId,
    userId,
    model: SONIOX_MODEL,
    voice: SONIOX_VOICE,
    language,
    characters,
    estimatedTokens,
  };
  console.info(
    JSON.stringify({
      ...logBase,
      event: 'started',
      usage: metering.snapshot,
    }),
  );

  let completion: {
    status: number;
    outcome: 'success' | 'upstream_error' | 'network_error' | 'cancelled';
    audioBytes?: number;
    errorType?: string;
    upstreamRequestId?: string;
  } = { status: 502, outcome: 'network_error' };

  try {
    const upstream = await fetch(SONIOX_TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      },
      body: JSON.stringify({
        model: SONIOX_MODEL,
        language,
        voice: SONIOX_VOICE,
        audio_format: 'mp3',
        text: input,
        client_reference_id: requestId,
      }),
      signal: request.signal,
    });

    if (!upstream.ok) {
      const error = (await upstream.json().catch(() => null)) as {
        error_type?: unknown;
        error_message?: unknown;
        request_id?: unknown;
      } | null;
      const errorType = typeof error?.error_type === 'string' ? error.error_type : 'upstream_error';
      const upstreamRequestId =
        typeof error?.request_id === 'string'
          ? error.request_id
          : upstream.headers.get('x-request-id') || undefined;
      completion = {
        status: upstream.status,
        outcome: 'upstream_error',
        errorType,
        upstreamRequestId,
      };
      return NextResponse.json(
        {
          error: {
            message:
              typeof error?.error_message === 'string'
                ? error.error_message
                : 'Soniox TTS request failed',
            type: errorType,
            requestId: typeof error?.request_id === 'string' ? error.request_id : undefined,
          },
        },
        { status: upstream.status },
      );
    }

    const audio = await upstream.arrayBuffer();
    if (audio.byteLength === 0) {
      completion = { status: 502, outcome: 'upstream_error', errorType: 'empty_audio' };
      return NextResponse.json(
        { error: { message: 'Soniox returned no audio', type: 'upstream_error' } },
        { status: 502 },
      );
    }
    completion = {
      status: 200,
      outcome: 'success',
      audioBytes: audio.byteLength,
      upstreamRequestId: upstream.headers.get('x-request-id') || undefined,
    };
    return new NextResponse(audio, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audio.byteLength),
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    if (request.signal.aborted) {
      completion = { status: 499, outcome: 'cancelled', errorType: 'request_cancelled' };
      return NextResponse.json(
        { error: { message: 'Soniox TTS request was cancelled', type: 'request_cancelled' } },
        { status: 499 },
      );
    }
    console.error('Soniox TTS upstream error:', error);
    completion = { status: 502, outcome: 'network_error', errorType: 'upstream_error' };
    return NextResponse.json(
      { error: { message: 'Soniox TTS is unavailable', type: 'upstream_error' } },
      { status: 502 },
    );
  } finally {
    sonioxUsageMeter.finish(metering.lease);
    console.info(
      JSON.stringify({
        ...logBase,
        event: 'completed',
        ...completion,
        durationMs: Date.now() - startedAt,
        usage: sonioxUsageMeter.snapshot(),
      }),
    );
  }
}
