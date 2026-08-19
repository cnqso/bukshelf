import { AppService } from '@/types/system';
import { BufferedTTSClient } from './BufferedTTSClient';
import { BookTTSCacheStore, getTTSCacheConfig } from './providers/bookCacheStore';
import { CachingProvider } from './providers/cache';
import { SONIOX_VOICE_ID, SonioxSpeechProvider } from './providers/soniox';
import { SpeechProvider } from './providers/types';
import type { TTSController } from './TTSController';
import { TTSUtils } from './TTSUtils';
import type { TTSVoicesGroup } from './types';

export class SonioxTTSClient extends BufferedTTSClient {
  #sonioxProvider: SonioxSpeechProvider;

  constructor(controller?: TTSController, appService?: AppService | null) {
    const sonioxProvider = new SonioxSpeechProvider();
    let provider: SpeechProvider = sonioxProvider;
    const cacheConfig = getTTSCacheConfig();
    if (appService && cacheConfig.enabled) {
      provider = new CachingProvider(
        sonioxProvider,
        new BookTTSCacheStore(
          appService,
          () => controller?.bookKey?.split('-')[0] || null,
          cacheConfig.budgetMB * 1024 * 1024,
        ),
      );
    }
    super(provider, controller, appService);
    this.#sonioxProvider = sonioxProvider;
  }

  override async init(): Promise<boolean> {
    this.voices = await this.#sonioxProvider.getAllVoices();
    if (await this.#sonioxProvider.init()) {
      this.initialized = true;
      return true;
    }
    // Keep a previously selected Soniox book usable offline when its audio is
    // already cached, but do not advertise an unavailable provider by default.
    this.initialized =
      this.provider instanceof CachingProvider && TTSUtils.getPreferredClient() === this.name;
    return this.initialized;
  }

  override async getVoices(lang: string): Promise<TTSVoicesGroup[]> {
    const voice = { id: SONIOX_VOICE_ID, name: SONIOX_VOICE_ID, lang, disabled: !this.initialized };
    return [
      {
        id: this.name,
        name: this.provider.label,
        voices: [voice],
        disabled: !this.initialized,
      },
    ];
  }

  override getCapabilities() {
    return { ...super.getCapabilities(), wordBoundaries: false };
  }
}
