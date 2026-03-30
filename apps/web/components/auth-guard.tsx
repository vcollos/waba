'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { readToken } from '../lib/api';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const token = readToken();
    if (!token && pathname !== '/login') {
      router.replace('/login');
      return;
    }

    if (token && pathname === '/login') {
      router.replace('/dashboard');
      return;
    }

    setReady(true);
  }, [pathname, router]);

  if (!ready) {
    return <div className="loading">Carregando...</div>;
  }

  return <>{children}</>;
}
