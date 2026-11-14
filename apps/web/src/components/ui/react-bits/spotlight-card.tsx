import Link from 'next/link';
import type { ReactNode } from 'react';

export function SpotlightCard({
  href,
  children,
  className,
  ...props
}: {
  href: string;
  children: ReactNode;
  className?: string;
  'data-motion-item'?: '';
}) {
  return (
    <Link
      href={href}
      {...props}
      onPointerMove={(event) => {
        event.currentTarget.style.setProperty('--pointer-x', `${event.nativeEvent.offsetX}px`);
        event.currentTarget.style.setProperty('--pointer-y', `${event.nativeEvent.offsetY}px`);
      }}
      className={`rb-spotlight-card relative isolate flex flex-col gap-0.5 overflow-hidden px-5 py-4 hover:bg-panel-2 ${className ?? ''}`}
    >
      {children}
    </Link>
  );
}
