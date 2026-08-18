'use client';

/**
 * Publishes the current route into the IGRIS Context Envelope (U1). Rendered once
 * in the root layout; renders nothing. On every navigation it updates route +
 * surface and — when the surface changes — drops stale entity ids, so the
 * envelope always reflects where the user actually is. Pure presentation: no
 * network, no side effects beyond the in-memory envelope.
 */
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { publishRoute } from '@/lib/context-envelope';

export function ContextRouteSync() {
  const pathname = usePathname();
  useEffect(() => {
    publishRoute(pathname ?? '/');
  }, [pathname]);
  return null;
}
