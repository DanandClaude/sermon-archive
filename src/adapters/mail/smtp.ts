import nodemailer, { type Transporter } from 'nodemailer';
import type { Mailer, MailMessage } from './types';

/** Works with any SMTP provider (Postmark, Resend, Amazon SES, Google Workspace relay). */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}
