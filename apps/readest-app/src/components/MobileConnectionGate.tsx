'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { getSelectedBukshelfServerUrl, isMobileTauriClient } from '@/services/mobileServer';

export default function MobileConnectionGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { token, user } = useAuth();
  const mobile = isMobileTauriClient();
  const isAuthPage = pathname === '/auth';
  const ready = Boolean(getSelectedBukshelfServerUrl() && token && user);

  useEffect(() => {
    if (!mobile || isAuthPage || ready) return;
    const current = `${pathname}${window.location.search}`;
    router.replace(`/auth?redirect=${encodeURIComponent(current)}`);
  }, [isAuthPage, mobile, pathname, ready, router]);

  if (mobile && !isAuthPage && !ready) return null;
  return children;
}
