'use client';

import type { MeResponse } from '@esports/shared';
import { setLocaleCookie } from '@/i18n/locale';

/**
 * After sign-in: adopt the user's saved language (if any), then do a full navigation so every
 * server-rendered piece re-renders with the new session and language.
 */
export function enterDashboard(me: MeResponse, path = '/dashboard'): void {
  if (me.user.locale) setLocaleCookie(me.user.locale);
  window.location.assign(path);
}
