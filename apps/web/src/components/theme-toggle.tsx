'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

type Theme = 'system' | 'light' | 'dark';

const nextTheme: Record<Theme, Theme> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

const themeIcon = {
  system: Monitor,
  light: Sun,
  dark: Moon,
} satisfies Record<Theme, typeof Monitor>;

const themeStorageKey = 'esportproject-theme';

function isTheme(value: string | null | undefined): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function ThemeToggle() {
  const t = useTranslations('common');
  const [theme, setTheme] = useState<Theme>('system');
  const Icon = themeIcon[theme];
  const labelKey = `theme${theme[0].toUpperCase()}${theme.slice(1)}` as const;
  const next = nextTheme[theme];
  const nextLabelKey = `switchThemeTo${next[0].toUpperCase()}${next.slice(1)}` as const;
  const label = `${t(labelKey)}. ${t(nextLabelKey)}`;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(themeStorageKey);
      const current = isTheme(saved) ? saved : document.documentElement.dataset.theme;
      if (isTheme(current)) setTheme(current);
    } catch (error) {
      console.error('Saved theme preference could not be read', error);
    }
  }, []);

  const changeTheme = () => {
    const updated = nextTheme[theme];
    document.documentElement.dataset.theme = updated;
    setTheme(updated);
    try {
      window.localStorage.setItem(themeStorageKey, updated);
    } catch (error) {
      console.error('Theme preference could not be saved', error);
    }
  };

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={changeTheme}
      className="inline-flex size-9 items-center justify-center rounded-md text-ink hover:bg-panel-2"
    >
      <Icon className="size-[1.125rem]" aria-hidden="true" />
    </button>
  );
}
