/**
 * Outgoing email. Two transports:
 * - `outbox` (development/test only): stores rendered HTML and text in app.dev_outbox.
 *   Refused in production by env validation, because bodies can contain password-reset links.
 * - `smtp`: any SMTP provider; transport settings remain in config/env.ts.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { type Env, ENV } from '../config/env.js';
import { DB, type Database } from '../db/client.js';
import { devOutbox } from '../db/schema.js';
import { type MailLocale } from './templates/components.js';
import {
  renderEmail,
  type EmailInput,
  type MailTemplate,
  type RenderedEmail,
} from './templates/render-email.js';

export type { MailTemplate } from './templates/render-email.js';

interface AssistantEmailMessage {
  /** One address, or several separated by commas. */
  to: string;
  subject: string;
  text: string;
  template: 'assistant_email';
  cc?: string[];
  replyTo?: string;
  locale?: MailLocale;
}

interface OutgoingMessage {
  to: string;
  template: MailTemplate;
  email: RenderedEmail;
  locale: MailLocale;
  autoSubmitted: boolean;
  cc?: string[];
  replyTo?: string;
}

function senderAddress(value: string): string | undefined {
  const parsed = /<\s*([^<>]+?)\s*>/.exec(value)?.[1]?.trim() ?? value.trim();
  return /^[^<>\s@]+@[^<>\s@]+$/.test(parsed) ? parsed : undefined;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private transporter: Transporter | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DB) private readonly db: Database,
  ) {
    if (env.MAIL_TRANSPORT === 'smtp') {
      this.transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT ?? 587,
        secure: env.SMTP_SECURE === 'true',
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      });
    }
  }

  /** Sends a user-authored email; its custom subject and body are preserved as plain text too. */
  send(message: AssistantEmailMessage): Promise<boolean> {
    const locale = message.locale ?? 'en';
    const input: EmailInput = {
      type: 'assistant_email',
      data: { subject: message.subject, body: message.text },
    };
    return this.sendTemplate({
      to: message.to,
      template: message.template,
      input,
      locale,
      autoSubmitted: false,
      cc: message.cc,
      replyTo: message.replyTo,
    });
  }

  sendInvitation(
    to: string,
    data: { organizationName: string; inviterName: string | null; url: string; expiresAt: Date },
    locale: MailLocale = 'en',
  ) {
    return this.sendSystem(to, locale, { type: 'invitation', data });
  }

  /** The one-time code that opens a contract for signing. Contains no link and no contract text. */
  sendSigningCode(
    to: string,
    data: { organizationName: string; contractNumber: string; code: string; minutes: number },
    locale: MailLocale = 'en',
  ) {
    return this.sendSystem(to, locale, { type: 'signing_code', data });
  }

  sendPasswordReset(to: string, data: { url: string; minutes: number }, locale: MailLocale = 'en') {
    return this.sendSystem(to, locale, { type: 'password_reset', data });
  }

  sendPasswordChanged(to: string, locale: MailLocale = 'en') {
    return this.sendSystem(to, locale, { type: 'password_changed', data: {} });
  }

  sendContractTermination(
    to: string,
    data: { contractNumber: string; status: string; note: string | null },
    locale: MailLocale = 'en',
  ) {
    return this.sendSystem(to, locale, { type: 'contract_termination', data });
  }

  private sendSystem(to: string, locale: MailLocale, input: EmailInput): Promise<boolean> {
    return this.sendTemplate({
      to,
      template: input.type,
      input,
      locale,
      autoSubmitted: true,
    });
  }

  private sendTemplate(
    message: Omit<OutgoingMessage, 'email'> & { input: EmailInput },
  ): Promise<boolean> {
    try {
      return this.deliver({
        ...message,
        email: renderEmail(message.input, {
          locale: message.locale,
          appUrl: this.env.WEB_APP_URL,
          supportContact: this.env.MAIL_FROM,
        }),
      });
    } catch (err) {
      this.logger.error(
        `Failed to render ${message.template} email: ${err instanceof Error ? err.message : String(err)}`,
      );
      return Promise.resolve(false);
    }
  }

  /** Returns true if the message was handed to a transport. Never throws to the caller. */
  private async deliver(message: OutgoingMessage): Promise<boolean> {
    try {
      if (this.transporter) {
        const address = this.env.MAIL_FROM;
        const fromAddress = address ? senderAddress(address) : undefined;
        const from = fromAddress
          ? {
              name: message.locale === 'ar' ? 'إدارة النادي' : 'Club Manager',
              address: fromAddress,
            }
          : address;
        await this.transporter.sendMail({
          from,
          to: message.to,
          ...(message.cc?.length ? { cc: message.cc } : {}),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          subject: message.email.subject,
          text: message.email.text,
          html: message.email.html,
          ...(message.autoSubmitted ? { headers: { 'Auto-Submitted': 'auto-generated' } } : {}),
        });
      } else {
        const headers = [
          message.cc?.length ? `Cc: ${message.cc.join(', ')}` : '',
          message.replyTo ? `Reply-To: ${message.replyTo}` : '',
        ].filter(Boolean);
        const text = headers.length
          ? `${headers.join('\n')}\n\n${message.email.text}`
          : message.email.text;
        await this.db.insert(devOutbox).values({
          to: message.to,
          subject: message.email.subject,
          template: message.template,
          html: message.email.html,
          text,
        });
        if (this.env.NODE_ENV === 'development') {
          this.logger.log(`[outbox] to=${message.to} subject="${message.email.subject}"\n${text}`);
        }
      }
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to send ${message.template} email: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
