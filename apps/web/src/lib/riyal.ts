'use client';

import { RIYAL_SIGN } from '@esports/shared';
import { useSyncExternalStore } from 'react';

/**
 * Whether the riyal sign (U+20C1) can be shown. True only after the browser has actually loaded
 * a font face covering it (the bundled one, declared in globals.css); until then, or if loading
 * fails, amounts read "SAR" — never a missing-glyph box.
 */
let ready = false;
let started = false;
const listeners = new Set<() => void>();

function start() {
  if (started || typeof document === 'undefined' || !('fonts' in document)) return;
  started = true;
  // Both families the dashboard uses (Latin pages and Arabic pages), regular and semibold.
  const fonts = ['"IBM Plex Sans"', '"IBM Plex Sans Arabic"'].flatMap((f) => [
    `400 16px ${f}`,
    `600 16px ${f}`,
  ]);
  Promise.all(fonts.map((f) => document.fonts.load(f, RIYAL_SIGN)))
    .then((loaded) => {
      ready =
        loaded.every((faces) => faces.length > 0) &&
        fonts.every((f) => document.fonts.check(f, RIYAL_SIGN));
      if (ready) listeners.forEach((l) => l());
    })
    .catch(() => undefined);
}

export function useRiyalSign(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      start();
      return () => listeners.delete(onChange);
    },
    () => ready,
    () => false,
  );
}
