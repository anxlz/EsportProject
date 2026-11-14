'use client';

import { useGSAP } from '@gsap/react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

gsap.registerPlugin(useGSAP, ScrollTrigger);

export function ScrollReveal({ children }: { children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = () => setReducedMotion(preference.matches);
    updatePreference();
    preference.addEventListener('change', updatePreference);
    return () => preference.removeEventListener('change', updatePreference);
  }, []);

  useGSAP(
    () => {
      if (reducedMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const rtl = document.documentElement.dir === 'rtl';
      const fromX = rtl ? -16 : 16;
      const revealOptions = {
        autoAlpha: 0,
        x: fromX,
        y: 8,
        duration: 0.55,
        ease: 'power2.out',
        clearProps: 'all',
      } as const;
      const scrollOptions = { start: 'top 88%', once: true };

      gsap.utils.toArray<HTMLElement>('[data-motion-reveal]', root.current).forEach((element) => {
        gsap.from(element, {
          ...revealOptions,
          scrollTrigger: { trigger: element, ...scrollOptions },
        });
      });

      gsap.utils.toArray<HTMLElement>('[data-motion-stagger]', root.current).forEach((group) => {
        const items = group.querySelectorAll<HTMLElement>('[data-motion-item]');
        if (!items.length) return;
        gsap.from(items, {
          ...revealOptions,
          stagger: 0.08,
          scrollTrigger: { trigger: group, ...scrollOptions },
        });
      });

      gsap.utils.toArray<HTMLElement>('[data-motion-counter]', root.current).forEach((element) => {
        const target = Number(element.dataset.motionCounter);
        if (!Number.isFinite(target)) return;
        gsap.fromTo(
          element,
          { textContent: 0 },
          {
            textContent: target,
            duration: 0.8,
            snap: { textContent: 1 },
            ease: 'power1.out',
            scrollTrigger: { trigger: element, ...scrollOptions },
          },
        );
      });
    },
    { scope: root, dependencies: [pathname, reducedMotion], revertOnUpdate: true },
  );

  return (
    <div ref={root} className="contents">
      {children}
    </div>
  );
}
