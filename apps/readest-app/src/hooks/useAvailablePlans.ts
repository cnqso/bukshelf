import { useEffect, useState } from 'react';
import { fetchAndTransformIAPPlans, isIAPAvailable } from '@/libs/payment/iap/client';
import { AvailablePlan } from '@/types/quota';
import { stubTranslation as _ } from '@/utils/misc';

const IAP_PRODUCT_IDS = [
  'com.bilingify.readest.monthly.plus',
  'com.bilingify.readest.monthly.pro',
  'com.bilingify.readest.storage.1gb.purchase',
  'com.bilingify.readest.storage.2gb.purchase',
  'com.bilingify.readest.storage.5gb.purchase',
  'com.bilingify.readest.storage.10gb.purchase',
];

interface UseAvailablePlansParams {
  hasIAP: boolean;
  onError?: (message: string) => void;
}

// IAP is the only purchase path. There is no web/desktop equivalent, so a
// platform without IAP simply has no plans to offer.
export const useAvailablePlans = ({ hasIAP, onError }: UseAvailablePlansParams) => {
  const [availablePlans, setAvailablePlans] = useState<AvailablePlan[]>([]);
  const [iapAvailable, setIapAvailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const fetchPlans = async () => {
      if (!hasIAP) {
        setAvailablePlans([]);
        setIapAvailable(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        if (await isIAPAvailable()) {
          const plans = await fetchAndTransformIAPPlans(IAP_PRODUCT_IDS);
          setAvailablePlans(plans);
          setIapAvailable(true);
        } else {
          setAvailablePlans([]);
          setIapAvailable(false);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error('Unknown error');
        setError(error);
        console.error('Failed to fetch IAP plans:', error);

        if (onError) {
          onError(_('Failed to load subscription plans.'));
        }
      } finally {
        setLoading(false);
      }
    };

    fetchPlans();
  }, [hasIAP, onError]);

  return { availablePlans, iapAvailable, loading, error };
};
