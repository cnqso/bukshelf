import '@/i18n/i18n';
import { useCallback } from 'react';
import { useTranslation as _useTranslation } from 'react-i18next';
import { getBrandName } from '@/services/runtimeConfig';

export type TranslationFunc = (key: string, options?: Record<string, number | string>) => string;

export const useTranslation = (namespace: string = 'translation') => {
  const { t } = _useTranslation(namespace);
  const brandName = getBrandName();

  return useCallback(
    (key: string, options = {}) => {
      const translated = t(key, { defaultValue: key, ...options });
      return brandName === 'Readest' ? translated : translated.replaceAll('Readest', brandName);
    },
    [brandName, t],
  );
};
