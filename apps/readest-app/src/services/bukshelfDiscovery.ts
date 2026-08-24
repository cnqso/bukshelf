import { mergeRuntimeConfig } from './runtimeConfig';

interface BukshelfDiscovery {
  capabilities?: {
    readerAI?: boolean;
    textToSpeech?: boolean;
  };
  models?: {
    readerAI?: string;
  };
}

export const discoverBukshelfServer = async (serverUrl: string): Promise<BukshelfDiscovery> => {
  const response = await fetch(`${serverUrl.replace(/\/$/, '')}/.well-known/bukshelf`);
  if (!response.ok) throw new Error(`Bukshelf discovery failed: ${response.status}`);
  const discovery = (await response.json()) as BukshelfDiscovery;
  mergeRuntimeConfig({
    openRouterServerEnabled: discovery.capabilities?.readerAI === true,
    openRouterChatModel: discovery.models?.readerAI,
    sonioxServerEnabled: discovery.capabilities?.textToSpeech === true,
  });
  return discovery;
};
