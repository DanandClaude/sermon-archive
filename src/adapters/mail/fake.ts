import type { Mailer, MailMessage } from './types';

export type SentMail = MailMessage & { sentAt: Date };

/** Keeps mail in memory. In development, /dev/outbox lists it so sign-in links can be clicked. */
export class FakeMailer implements Mailer {
  readonly outbox: SentMail[] = [];

  async send(message: MailMessage): Promise<void> {
    this.outbox.push({ ...message, sentAt: new Date() });
  }
}
