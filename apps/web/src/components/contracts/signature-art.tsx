'use client';

/**
 * How a signature looks, on screen: typed signatures in blue in the signer's chosen font (the
 * same OFL fonts the PDF embeds), drawn ones as the signer's own strokes in the same blue. The
 * drawing pad records vector strokes on a fixed 600×200 canvas, exactly what the API stores.
 */
import '@fontsource/dancing-script/400.css';
import '@fontsource/great-vibes/400.css';
import '@fontsource/caveat/400.css';
import '@fontsource/aref-ruqaa/400.css';
import '@fontsource/amiri/400.css';
import {
  DRAW_CANVAS,
  SIGNATURE_FONTS,
  SIGNATURE_INK,
  type SignatureFontKey,
} from '@esports/shared';
import { type PointerEvent, useCallback, useEffect, useRef } from 'react';
import { cx } from '@/components/ui';

export type Strokes = [number, number][][];

export const fontFamily = (key: SignatureFontKey) =>
  `'${SIGNATURE_FONTS.find((f) => f.key === key)?.family ?? 'Dancing Script'}', cursive`;

export function TypedSignature({
  name,
  fontKey,
  className,
}: {
  name: string;
  fontKey: SignatureFontKey;
  className?: string;
}) {
  return (
    <span
      dir="auto"
      className={cx('inline-block leading-tight', className ?? 'text-4xl')}
      style={{ fontFamily: fontFamily(fontKey), color: SIGNATURE_INK }}
    >
      {name}
    </span>
  );
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function DrawnSignature({ strokes, className }: { strokes: Strokes; className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${DRAW_CANVAS.width} ${DRAW_CANVAS.height}`}
      className={cx('h-16 w-auto max-w-full', className)}
      fill="none"
      stroke={SIGNATURE_INK}
      strokeWidth={3.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {strokes.map((st, i) =>
        st.length === 1 ? (
          <circle key={i} cx={st[0]![0]} cy={st[0]![1]} r={2} fill={SIGNATURE_INK} />
        ) : (
          <path key={i} d={`M${st.map(([x, y]) => `${r1(x)} ${r1(y)}`).join('L')}`} />
        ),
      )}
    </svg>
  );
}

const LIMITS = { strokes: 60, perStroke: 2000, total: 6000 };

/** Pointer drawing (mouse, touch, pen). Calls `onChange` with the strokes after each one ends. */
export function SignaturePad({
  strokes,
  onChange,
  label,
}: {
  strokes: Strokes;
  onChange: (s: Strokes) => void;
  label: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef<[number, number][] | null>(null);
  const total = strokes.reduce((n, s) => n + s.length, 0);

  const paint = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const scale = c.width / DRAW_CANVAS.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.strokeStyle = SIGNATURE_INK;
    ctx.fillStyle = SIGNATURE_INK;
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const st of [...strokes, ...(current.current ? [current.current] : [])]) {
      if (st.length === 1) {
        ctx.beginPath();
        ctx.arc(st[0]![0], st[0]![1], 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      st.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
  }, [strokes]);

  // Keep the backing store sharp at any size and pixel density.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(c.clientWidth * dpr);
      c.height = Math.round(c.clientHeight * dpr);
      paint();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(c);
    return () => ro.disconnect();
  }, [paint]);

  const at = (e: PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * DRAW_CANVAS.width;
    const y = ((e.clientY - r.top) / r.height) * DRAW_CANVAS.height;
    return [
      r1(Math.min(DRAW_CANVAS.width, Math.max(0, x))),
      r1(Math.min(DRAW_CANVAS.height, Math.max(0, y))),
    ];
  };

  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label={label}
      className="block aspect-[3/1] w-full cursor-crosshair touch-none rounded-md border border-dashed border-line-strong bg-white"
      onPointerDown={(e) => {
        if (strokes.length >= LIMITS.strokes || total >= LIMITS.total) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        current.current = [at(e)];
        paint();
      }}
      onPointerMove={(e) => {
        const st = current.current;
        if (!st) return;
        const p = at(e);
        const last = st[st.length - 1]!;
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1.5) return;
        if (st.length >= LIMITS.perStroke || total + st.length >= LIMITS.total) return;
        st.push(p);
        paint();
      }}
      onPointerUp={() => {
        const st = current.current;
        current.current = null;
        if (st) onChange([...strokes, st]);
      }}
      onPointerCancel={() => {
        current.current = null;
        paint();
      }}
    />
  );
}
