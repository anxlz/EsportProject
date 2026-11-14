import { describe, expect, test } from 'bun:test';
import { renderEmail, type EmailInput } from './render-email.js';

const appUrl = 'https://club.example';
const options = { appUrl, supportContact: 'support@club.example' };

const emails: EmailInput[] = [
  {
    type: 'invitation',
    data: {
      organizationName: 'Falcons',
      inviterName: 'Amina',
      url: `${appUrl}/invite/sample-token`,
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    },
  },
  {
    type: 'password_reset',
    data: { url: `${appUrl}/reset-password?token=sample-token`, minutes: 60 },
  },
  { type: 'password_changed', data: {} },
  {
    type: 'signing_code',
    data: { organizationName: 'Falcons', contractNumber: 'C-26-014', code: '042681', minutes: 10 },
  },
  {
    type: 'assistant_email',
    data: { subject: 'Review on Thursday', body: 'Hello <b>Saad</b>.\nSee you soon.' },
  },
  {
    type: 'contract_termination',
    data: {
      contractNumber: 'C-26-014',
      status: 'accepted',
      note: 'Effective on 2026-12-01.',
    },
  },
];

describe('mail templates', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`renders every email in ${locale}`, () => {
      for (const input of emails) {
        const rendered = renderEmail(input, { ...options, locale });
        expect(rendered.html).toContain(
          `<html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}">`,
        );
        expect(rendered.subject.length).toBeGreaterThan(0);
        expect(rendered.text.length).toBeGreaterThan(0);
        expect(rendered.html.match(/<v:roundrect\b/g)).toHaveLength(1);
        const links = [...rendered.html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(
          (match) => new URL(match[1]!.replace(/&amp;/g, '&')),
        );
        expect(links.length).toBeGreaterThan(0);
        for (const link of links) {
          expect(link.protocol).toBe('https:');
          expect(link.origin).toBe(appUrl);
          expect(rendered.text).toContain(link.href);
        }
        expect(Buffer.byteLength(rendered.html, 'utf8')).toBeLessThan(90 * 1024);
      }
    });
  }

  test('escapes dynamic HTML and keeps a button URL in plain text', () => {
    const url = `${appUrl}/invite/sample-token?source=mail`;
    const rendered = renderEmail(
      {
        type: 'invitation',
        data: {
          organizationName: '<script>alert("x")</script>',
          inviterName: '<img src=x onerror=alert(1)>',
          url,
          expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        },
      },
      { ...options, locale: 'en' },
    );

    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.text).toContain(url);
  });

  test('only creates links on the configured HTTPS app origin', () => {
    const rendered = renderEmail(
      {
        type: 'password_reset',
        data: { url: `${appUrl}/reset-password?token=sample`, minutes: 60 },
      },
      { ...options, locale: 'en' },
    );
    const links = [...rendered.html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(
      (match) => new URL(match[1]!.replace(/&amp;/g, '&')),
    );

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.protocol).toBe('https:');
      expect(link.origin).toBe(appUrl);
      expect(rendered.text).toContain(link.href);
    }

    expect(() =>
      renderEmail(
        { type: 'password_reset', data: { url: 'https://evil.example/reset', minutes: 60 } },
        { ...options, locale: 'en' },
      ),
    ).toThrow(/configured app URL/);
  });
});
