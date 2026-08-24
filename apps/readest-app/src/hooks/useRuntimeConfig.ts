import { useSyncExternalStore } from 'react';
import { getRuntimeConfig, subscribeRuntimeConfig } from '@/services/runtimeConfig';

export const useRuntimeConfig = () =>
  useSyncExternalStore(subscribeRuntimeConfig, getRuntimeConfig, () => undefined);
