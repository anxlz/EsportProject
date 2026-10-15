import { type NextRequest, NextResponse } from 'next/server';

/**
 * Fast redirect for signed-out visitors. This only checks that a session cookie EXISTS — it is
 * a UX shortcut, not security. Every API call is authorized by the backend.
 */
const SESSION_COOKIES = ['__Host-esp_sid', 'esp_sid'];

export function proxy(request: NextRequest) {
  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));
  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/platform/:path*'],
};
