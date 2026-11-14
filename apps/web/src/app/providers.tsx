'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { ToastProvider } from '@/components/ui';
import { GlobalLoadingProvider } from '@/components/global-loading';
import { ApiError } from '@/lib/api';
import { SmoothScrollProvider } from './smooth-scroll-provider';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <SmoothScrollProvider>
        <ToastProvider>
          <GlobalLoadingProvider>{children}</GlobalLoadingProvider>
        </ToastProvider>
      </SmoothScrollProvider>
    </QueryClientProvider>
  );
}
