'use client';

import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

const MINIMUM_DISPLAY_MS = 300;
const MAXIMUM_DISPLAY_MS = 15_000;

interface LoadingContextValue {
  startLoading: () => void;
  stopLoading: () => void;
}

const LoadingContext = createContext<LoadingContextValue | null>(null);

function LoadingRouteTracker({ stopLoading }: LoadingContextValue) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const route = `${pathname}?${searchParams.toString()}`;

  useEffect(() => {
    stopLoading();
  }, [route, stopLoading]);

  return null;
}

function LoadingOverlay({ visible }: { visible: boolean }) {
  const t = useTranslations('common');
  const tApp = useTranslations('app');

  return (
    <div
      aria-hidden={!visible}
      className={`global-loading-overlay fixed inset-0 z-[100] flex items-center justify-center bg-bg/90 backdrop-blur-sm ${
        visible ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="flex flex-col items-center gap-3 text-center"
      >
        <span className="global-loading-mark inline-flex size-14 items-center justify-center rounded-2xl bg-turf text-turf-ink shadow-lg">
          <Sparkles className="size-7" aria-hidden="true" />
        </span>
        <span className="text-sm font-semibold text-ink">{tApp('name')}</span>
        <span className="sr-only">{t('loading')}</span>
      </div>
    </div>
  );
}

export function GlobalLoadingProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(true);
  const startedAt = useRef<number | null>(null);
  const stopRequested = useRef(false);
  const minimumTimer = useRef<number | undefined>(undefined);
  const maximumTimer = useRef<number | undefined>(undefined);

  const startLoading = useCallback(() => {
    stopRequested.current = false;
    if (minimumTimer.current !== undefined) {
      window.clearTimeout(minimumTimer.current);
      minimumTimer.current = undefined;
    }
    if (startedAt.current !== null) return;

    startedAt.current = Date.now();
    setVisible(true);
    maximumTimer.current = window.setTimeout(() => {
      startedAt.current = null;
      stopRequested.current = false;
      maximumTimer.current = undefined;
      setVisible(false);
    }, MAXIMUM_DISPLAY_MS);
  }, []);

  const stopLoading = useCallback(() => {
    if (startedAt.current === null) return;
    stopRequested.current = true;
    if (minimumTimer.current !== undefined) window.clearTimeout(minimumTimer.current);
    const elapsed = Date.now() - startedAt.current;
    minimumTimer.current = window.setTimeout(
      () => {
        minimumTimer.current = undefined;
        if (!stopRequested.current) return;
        if (maximumTimer.current !== undefined) window.clearTimeout(maximumTimer.current);
        maximumTimer.current = undefined;
        startedAt.current = null;
        stopRequested.current = false;
        setVisible(false);
      },
      Math.max(0, MINIMUM_DISPLAY_MS - elapsed),
    );
  }, []);

  useEffect(() => {
    startLoading();
    stopLoading();

    let pendingActionUntil = 0;
    let pendingRequestId: number | undefined;

    const queueAction = () => {
      pendingActionUntil = Date.now() + 2_000;
      pendingRequestId = undefined;
    };
    const handleAction = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const action = target.closest('[data-loading]');
      if (!action || action.matches(':disabled,[aria-disabled="true"]')) return;
      queueAction();
    };

    const handleClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest<HTMLAnchorElement>('a[href]');
      if (anchor) {
        if (
          anchor.hasAttribute('download') ||
          anchor.target === '_blank' ||
          anchor.rel.split(/\s+/).includes('external')
        )
          return;
        const url = new URL(anchor.href, document.baseURI);
        if (url.origin !== window.location.origin) return;
        const current = new URL(window.location.href);
        if (url.pathname === current.pathname && url.search === current.search) return;
        startLoading();
        return;
      }

      if (target.closest('button,[role="button"]')) queueAction();
      else handleAction(event);
    };

    const handleSubmit = () => {
      startLoading();
      queueAction();
    };
    const handleChange = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.matches('input[type="file"]')) queueAction();
      else handleAction(event);
    };
    const handleApiStart = (event: Event) => {
      if (Date.now() > pendingActionUntil) return;
      const requestId = (event as CustomEvent<{ requestId?: unknown }>).detail?.requestId;
      if (typeof requestId !== 'number') return;
      pendingActionUntil = 0;
      pendingRequestId = requestId;
      startLoading();
    };
    const handleApiEnd = (event: Event) => {
      const requestId = (event as CustomEvent<{ requestId?: unknown }>).detail?.requestId;
      if (typeof requestId !== 'number' || requestId !== pendingRequestId) return;
      pendingRequestId = undefined;
      stopLoading();
    };

    document.addEventListener('click', handleClick, true);
    document.addEventListener('submit', handleSubmit, true);
    document.addEventListener('change', handleChange, true);
    window.addEventListener('app:api-start', handleApiStart);
    window.addEventListener('app:api-end', handleApiEnd);
    return () => {
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('submit', handleSubmit, true);
      document.removeEventListener('change', handleChange, true);
      window.removeEventListener('app:api-start', handleApiStart);
      window.removeEventListener('app:api-end', handleApiEnd);
      if (minimumTimer.current !== undefined) {
        window.clearTimeout(minimumTimer.current);
        minimumTimer.current = undefined;
      }
      if (maximumTimer.current !== undefined) {
        window.clearTimeout(maximumTimer.current);
        maximumTimer.current = undefined;
      }
      startedAt.current = null;
      stopRequested.current = false;
    };
  }, [startLoading, stopLoading]);

  return (
    <LoadingContext.Provider value={{ startLoading, stopLoading }}>
      <Suspense fallback={null}>
        <LoadingRouteTracker startLoading={startLoading} stopLoading={stopLoading} />
      </Suspense>
      {children}
      <LoadingOverlay visible={visible} />
    </LoadingContext.Provider>
  );
}

export function useGlobalLoading() {
  const context = useContext(LoadingContext);
  if (!context) throw new Error('useGlobalLoading must be used within GlobalLoadingProvider');
  return context;
}
