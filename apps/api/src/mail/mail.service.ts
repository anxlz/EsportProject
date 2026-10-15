/**
 * Outgoing email. Two transports:
 * - `outbox` (development/test only): writes messages to app.dev_outbox and the console.
 *   Refused in production by env validation, because bodies contain password-reset links.
 * - `smtp`: any SMTP provider (the provider is not chosen yet — see DECISIONS.md).
 *
 * Messages are bilingual (Arabic first, then English) because the recipient's language is not
 * always known (e.g. invitations sent to people without an account yet).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { type Env, ENV } from '../config/env';
import { DB, type Database } from '../db/client';
import { devOutbox } from '../db/schema';

export type MailTemplate = 'invitation' | 'password_reset';

interface Message {
  to: string;
  subject: string;
  text: string;
  template: MailTemplate;
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

  /** Returns true if the message was handed to a transport. Never throws to the caller. */
  async send(message: Message): Promise<boolean> {
    try {
      if (this.transporter) {
        await this.transporter.sendMail({
          from: this.env.MAIL_FROM,
          to: message.to,
          subject: message.subject,
          text: message.text,
        });
      } else {
        await this.db.insert(devOutbox).values(message);
        if (this.env.NODE_ENV === 'development') {
          this.logger.log(
            `[outbox] to=${message.to} subject="${message.subject}"\n${message.text}`,
          );
        }
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to send ${message.template} email: ${(err as Error).message}`);
      return false;
    }
  }

  sendInvitation(
    to: string,
    p: { organizationName: string; inviterName: string | null; url: string; expiresAt: Date },
  ) {
    const inviter = p.inviterName ?? '';
    const expires = p.expiresAt.toISOString().slice(0, 10);
    return this.send({
      to,
      template: 'invitation',
      subject: `دعوة للانضمام إلى ${p.organizationName} | Invitation to join ${p.organizationName}`,
      text: [
        `${inviter ? `${inviter} يدعوك` : 'تمت دعوتك'} للانضمام إلى ${p.organizationName}.`,
        `لقبول الدعوة افتح الرابط التالي (صالح حتى ${expires}):`,
        p.url,
        '',
        '—',
        '',
        `${inviter ? `${inviter} has invited you` : 'You have been invited'} to join ${p.organizationName}.`,
        `Open this link to accept (valid until ${expires}):`,
        p.url,
        '',
        'If you were not expecting this invitation, you can ignore this email.',
      ].join('\n'),
    });
  }

  sendPasswordReset(to: string, p: { url: string; minutes: number }) {
    return this.send({
      to,
      template: 'password_reset',
      subject: 'إعادة تعيين كلمة المرور | Reset your password',
      text: [
        `لإعادة تعيين كلمة المرور افتح الرابط التالي خلال ${p.minutes} دقيقة:`,
        p.url,
        'إذا لم تطلب ذلك فتجاهل هذه الرسالة.',
        '',
        '—',
        '',
        `To reset your password, open this link within ${p.minutes} minutes:`,
        p.url,
        'If you did not request this, ignore this email; your password stays unchanged.',
      ].join('\n'),
    });
  }
}
