'use client';

import { type ReactNode, useEffect } from 'react';

export function SmoothScrollProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let destroy: (() => void) | undefined;
    let idleCallbackId: number | undefined;
    let fallbackTimer: number | undefined;
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');

    const start = async () => {
      const currentGeneration = ++generation;
      if (motionPreference.matches) return;

      const [lenisModule, gsapModule, scrollTriggerModule] = await Promise.all([
        import('lenis'),
        import('gsap'),
        import('gsap/ScrollTrigger'),
      ]);
      if (disposed || currentGeneration !== generation || motionPreference.matches) return;

      const Lenis = lenisModule.default;
      const gsap = gsapModule.gsap;
      const { ScrollTrigger } = scrollTriggerModule;
      gsap.registerPlugin(ScrollTrigger);

      const lenis = new Lenis({ autoRaf: false, smoothWheel: true });
      const updateScrollTrigger = () => ScrollTrigger.update();
      const raf = (time: number) => lenis.raf(time * 1000);
      const root = document.documentElement;
      const previousOverflow = root.style.overflow;

      lenis.on('scroll', updateScrollTrigger);
      gsap.ticker.lagSmoothing(0);
      gsap.ticker.add(raf);
      root.classList.add('lenis');

      destroy = () => {
        gsap.ticker.remove(raf);
        gsap.ticker.lagSmoothing(500, 33);
        lenis.off('scroll', updateScrollTrigger);
        lenis.destroy();
        root.classList.remove('lenis');
        root.style.overflow = previousOverflow;
      };
    };

    const handleMotionPreference = () => {
      generation += 1;
      destroy?.();
      destroy = undefined;
      if (idleCallbackId !== undefined) {
        window.cancelIdleCallback(idleCallbackId);
        idleCallbackId = undefined;
      }
      if (fallbackTimer !== undefined) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
      }
      if (!motionPreference.matches) scheduleStart();
    };

    const scheduleStart = () => {
      if (motionPreference.matches) return;
      if (window.requestIdleCallback) {
        idleCallbackId = window.requestIdleCallback(
          () => {
            idleCallbackId = undefined;
            void start().catch((error: unknown) =>
              console.error('Smooth scrolling could not be initialized', error),
            );
          },
          { timeout: 1200 },
        );
      } else {
        fallbackTimer = window.setTimeout(() => {
          fallbackTimer = undefined;
          void start().catch((error: unknown) =>
            console.error('Smooth scrolling could not be initialized', error),
          );
        }, 300);
      }
    };

    motionPreference.addEventListener('change', handleMotionPreference);
    scheduleStart();
    return () => {
      disposed = true;
      generation += 1;
      motionPreference.removeEventListener('change', handleMotionPreference);
      if (idleCallbackId !== undefined) window.cancelIdleCallback(idleCallbackId);
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
      destroy?.();
    };
  }, []);

  return children;
}
