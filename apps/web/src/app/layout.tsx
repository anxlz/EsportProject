import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-500.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css';
import '@fontsource/cairo/latin-300.css';
import '@fontsource/cairo/arabic-300.css';
import '@fontsource/cairo/latin-400.css';
import '@fontsource/cairo/arabic-400.css';
import '@fontsource/cairo/latin-500.css';
import '@fontsource/cairo/arabic-500.css';
import '@fontsource/cairo/latin-600.css';
import '@fontsource/cairo/arabic-600.css';
import '@fontsource/cairo/latin-700.css';
import '@fontsource/cairo/arabic-700.css';
import '@fontsource/cairo/latin-800.css';
import '@fontsource/cairo/arabic-800.css';
import '@fontsource/tajawal/latin-300.css';
import '@fontsource/tajawal/arabic-300.css';
import '@fontsource/tajawal/latin-400.css';
import '@fontsource/tajawal/arabic-400.css';
import '@fontsource/tajawal/latin-500.css';
import '@fontsource/tajawal/arabic-500.css';
import '@fontsource/tajawal/latin-700.css';
import '@fontsource/tajawal/arabic-700.css';
import '@fontsource/tajawal/latin-800.css';
import '@fontsource/tajawal/arabic-800.css';
import '@fontsource/ibm-plex-sans-arabic/latin-300.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-300.css';
import '@fontsource/ibm-plex-sans-arabic/latin-400.css';
import '@fontsource/ibm-plex-sans-arabic/latin-500.css';
import '@fontsource/ibm-plex-sans-arabic/latin-600.css';
import '@fontsource/ibm-plex-sans-arabic/latin-700.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-700.css';
import '@fontsource/noto-kufi-arabic/latin-300.css';
import '@fontsource/noto-kufi-arabic/arabic-300.css';
import '@fontsource/noto-kufi-arabic/latin-400.css';
import '@fontsource/noto-kufi-arabic/arabic-400.css';
import '@fontsource/noto-kufi-arabic/latin-500.css';
import '@fontsource/noto-kufi-arabic/arabic-500.css';
import '@fontsource/noto-kufi-arabic/latin-600.css';
import '@fontsource/noto-kufi-arabic/arabic-600.css';
import '@fontsource/noto-kufi-arabic/latin-700.css';
import '@fontsource/noto-kufi-arabic/arabic-700.css';
import '@fontsource/noto-kufi-arabic/latin-800.css';
import '@fontsource/noto-kufi-arabic/arabic-800.css';
import '@fontsource/almarai/latin-300.css';
import '@fontsource/almarai/arabic-300.css';
import '@fontsource/almarai/latin-400.css';
import '@fontsource/almarai/arabic-400.css';
import '@fontsource/almarai/latin-700.css';
import '@fontsource/almarai/arabic-700.css';
import '@fontsource/almarai/latin-800.css';
import '@fontsource/almarai/arabic-800.css';
import '@fontsource/ibm-plex-sans/latin-300.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import './globals.css';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { dirFor } from '@/i18n/locale';
import { Providers } from './providers';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return {
    title: { default: t('name'), template: `%s | ${t('name')}` },
    description: t('tagline'),
    robots: { index: false, follow: false },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={dirFor(locale)} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(()=>{try{const t=localStorage.getItem('esportproject-theme');document.documentElement.dataset.theme=['light','dark','system'].includes(t)?t:'system'}catch(e){console.error('Saved theme preference could not be read',e);document.documentElement.dataset.theme='system'}})()",
          }}
        />
        {/* Tiny (1–2 KB) font for the riyal sign; preloaded so amounts switch to it at once. */}
        <link
          rel="preload"
          href="/fonts/saudi-riyal/saudi-riyal-regular.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
