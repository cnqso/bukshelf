'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import LibraryPage from '@/app/library/page';
import PublicLibraryPage from '@/components/PublicLibraryPage';
import { useAuth } from '@/context/AuthContext';
import { getBukshelfAuthStatus } from '@/services/bukshelfAuthClient';
import { getRuntimeConfig, isBukshelfAuthEnabled } from '@/services/runtimeConfig';

export default function HomePageContent() {
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

  // Keep the static Tauri shell and hosted SSR shell empty until runtime config
  // and local auth state are available, then choose public facade or owner UI.
  if (!isHydrated) return null;
  const publicLibraryEnabled = getRuntimeConfig()?.publicLibraryEnabled === true;
  if (publicLibraryEnabled && (!token || !user)) {
    return <PublicLibraryPage />;
  }
  return <LibraryPage />;
}
