'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import LibraryPage from '@/app/library/page';
import PublicLibraryPage from '@/components/PublicLibraryPage';
import { useAuth } from '@/context/AuthContext';
import { getBukshelfAuthStatus } from '@/services/bukshelfAuthClient';
import { isBukshelfAuthEnabled } from '@/services/runtimeConfig';

export default function HomePageContent({
  publicLibraryEnabled,
}: {
  publicLibraryEnabled: boolean;
}) {
  const { token, user } = useAuth();
  const router = useRouter();
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setIsHydrated(true);
    if (!isBukshelfAuthEnabled()) return;
    void getBukshelfAuthStatus()
      .then(({ configured }) => {
        if (!configured) router.replace('/auth?redirect=/');
      })
      .catch(() => undefined);
  }, [router]);

  // Server rendering always emits the public facade. On hydration we keep it
  // for signed-out visitors, while a stored owner session switches to the full
  // reader without changing the public API's access boundary.
  if (publicLibraryEnabled && (!isHydrated || !token || !user)) {
    return <PublicLibraryPage />;
  }
  return <LibraryPage />;
}
