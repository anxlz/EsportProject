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

export type MailTemplate =
  'invitation' | 'password_reset' | 'signing_code' | 'assistant_email' | 'contract_termination';

interface Message {
  /** One address, or several separated by commas. */
  to: string;
  subject: string;
  text: string;
  template: MailTemplate;
  cc?: string[];
  replyTo?: string;
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
          ...(message.cc?.length ? { cc: message.cc } : {}),
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          subject: message.subject,
          text: message.text,
        });
      } else {
        const headers = [
          message.cc?.length ? `Cc: ${message.cc.join(', ')}` : '',
          message.replyTo ? `Reply-To: ${message.replyTo}` : '',
        ].filter(Boolean);
        await this.db.insert(devOutbox).values({
          to: message.to,
          subject: message.subject,
          template: message.template,
          text: headers.length ? `${headers.join('\n')}\n\n${message.text}` : message.text,
        });
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

  /** The one-time code that opens a contract for signing. Contains no link and no contract text. */
  sendSigningCode(
    to: string,
    p: { organizationName: string; contractNumber: string; code: string; minutes: number },
  ) {
    return this.send({
      to,
      template: 'signing_code',
      subject: `رمز التحقق لتوقيع العقد ${p.contractNumber} | Signing code for contract ${p.contractNumber}`,
      text: [
        `رمز التحقق لفتح العقد ${p.contractNumber} من ${p.organizationName} للتوقيع:`,
        p.code,
        `صالح لمدة ${p.minutes} دقائق. لا تشارك هذا الرمز مع أحد.`,
        '',
        '—',
        '',
        `Your code to open contract ${p.contractNumber} from ${p.organizationName} for signing:`,
        p.code,
        `It is valid for ${p.minutes} minutes. Do not share it with anyone.`,
        'If you did not request this code, you can ignore this email.',
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

  sendContractTermination(
    to: string,
    p: { contractNumber: string; status: string; note: string | null },
  ) {
    const status =
      {
        requested: 'قيد المراجعة | Under review',
        accepted: 'مقبول | Accepted',
        rejected: 'مرفوض | Rejected',
        withdrawn: 'مسحوب | Withdrawn',
        executed: 'تم التنفيذ | Executed',
        expired: 'منتهي الصلاحية | Expired',
      }[p.status] ?? p.status;
    return this.send({
      to,
      template: 'contract_termination',
      subject: `تحديث إنهاء العقد ${p.contractNumber} | Contract ${p.contractNumber} termination update`,
      text: [
        `تحديث بشأن إنهاء العقد ${p.contractNumber}: ${status}.`,
        ...(p.note ? [p.note] : []),
        '—',
        '',
        `An update about termination of contract ${p.contractNumber}: ${status}.`,
        ...(p.note ? [p.note] : []),
        '',
        'This message is a status notification, not legal advice.',
      ].join('\n'),
    });
  }
}
