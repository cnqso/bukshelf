'use client';

import { useEffect, useState } from 'react';
import LibraryPage from '@/app/library/page';
import PublicLibraryPage from '@/components/PublicLibraryPage';
import { useAuth } from '@/context/AuthContext';

export default function HomePageContent({
  publicLibraryEnabled,
}: {
  publicLibraryEnabled: boolean;
}) {
  const { token, user } = useAuth();
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => setIsHydrated(true), []);

  // Server rendering always emits the public facade. On hydration we keep it
  // for signed-out visitors, while a stored owner session switches to the full
  // reader without changing the public API's access boundary.
  if (publicLibraryEnabled && (!isHydrated || !token || !user)) {
    return <PublicLibraryPage />;
  }
  return <LibraryPage />;
}
