import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { LOCALE_COOKIE, resolveLocale } from './locale';

/**
 * Locale comes from the NEXT_LOCALE cookie (set by the language switcher and synced from the
 * user's saved preference), falling back to the browser's Accept-Language, then English.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const locale = resolveLocale(
    store.get(LOCALE_COOKIE)?.value,
    (await headers()).get('accept-language'),
  );
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    timeZone: process.env.NEXT_PUBLIC_DEFAULT_TIME_ZONE ?? 'Asia/Riyadh',
  };
});
