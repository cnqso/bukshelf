import { fetchWithAuth, bukshelfProviderUrl } from '@/utils/fetch';
import type { TTSVoice } from '../types';
import {
  SpeechProvider,
  SpeechSynthesisPermanentError,
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
} from './types';

export const SONIOX_VOICE_ID = 'Kayla';

export class SonioxSpeechProvider implements SpeechProvider {
  readonly id = 'soniox-tts';
  readonly label = 'Soniox TTS';
  readonly fallbackVoiceId = SONIOX_VOICE_ID;
  readonly cacheable = true;

  async init(): Promise<boolean> {
    try {
      await fetchWithAuth(bukshelfProviderUrl('/api/tts/soniox'), { method: 'GET' });
      return true;
    } catch {
      return false;
    }
  }

  async getAllVoices(): Promise<TTSVoice[]> {
    return [{ id: SONIOX_VOICE_ID, name: SONIOX_VOICE_ID, lang: 'en' }];
  }

  async synthesize(
    req: SpeechSynthesisRequest,
    signal: AbortSignal,
  ): Promise<SpeechSynthesisResult> {
    const response = await fetchWithAuth(bukshelfProviderUrl('/api/tts/soniox'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: req.text, lang: req.lang, voice: SONIOX_VOICE_ID }),
      signal,
    });
    const audio = await response.arrayBuffer();
    if (audio.byteLength === 0) {
      throw new SpeechSynthesisPermanentError('Soniox returned no audio');
    }
    return { audio, boundaries: [] };
  }

  pickDefaultVoice(): string {
    return SONIOX_VOICE_ID;
  }
}
