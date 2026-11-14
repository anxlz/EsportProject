import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  renderEmail,
  type EmailInput,
  type MailTemplate,
} from '../src/mail/templates/render-email.js';

const appUrl = process.env.WEB_APP_URL ?? 'https://club-manager.example';
const organizationName = 'Falcons Esports Club';
const emails: Array<{ name: MailTemplate; input: EmailInput }> = [
  {
    name: 'invitation',
    input: {
      type: 'invitation',
      data: {
        organizationName,
        inviterName: 'Amina Hassan',
        url: `${appUrl}/invite/sample-invitation-token`,
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      },
    },
  },
  {
    name: 'password_reset',
    input: {
      type: 'password_reset',
      data: { url: `${appUrl}/reset-password?token=sample-reset-token`, minutes: 60 },
    },
  },
  { name: 'password_changed', input: { type: 'password_changed', data: {} } },
  {
    name: 'signing_code',
    input: {
      type: 'signing_code',
      data: {
        organizationName,
        contractNumber: 'CTR-2026-014',
        code: '042681',
        minutes: 10,
      },
    },
  },
  {
    name: 'contract_termination',
    input: {
      type: 'contract_termination',
      data: {
        contractNumber: 'CTR-2026-014',
        status: 'requested',
        note: 'The request is under review.',
      },
    },
  },
  {
    name: 'assistant_email',
    input: {
      type: 'assistant_email',
      data: {
        subject: 'Meeting follow-up',
        body: 'Hello,\n\nHere are the notes from our meeting.',
      },
    },
  },
];

const outputDir = resolve(import.meta.dir, '../../../tmp/mail-preview');
await mkdir(outputDir, { recursive: true });

const links: string[] = [];
for (const locale of ['en', 'ar'] as const) {
  for (const { name, input } of emails) {
    const filename = `${name}-${locale}.html`;
    const rendered = renderEmail(input, {
      locale,
      appUrl,
      supportContact: 'support@club-manager.example',
    });
    await writeFile(resolve(outputDir, filename), rendered.html, 'utf8');
    links.push(`<li><a href="${filename}">${name} (${locale}) — ${rendered.subject}</a></li>`);
  }
}

await writeFile(
  resolve(outputDir, 'index.html'),
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Email previews</title><h1>Email previews</h1><ul>${links.join('')}</ul></html>`,
  'utf8',
);
console.log(`Rendered ${emails.length * 2} email previews to ${outputDir}`);
