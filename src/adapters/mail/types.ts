export type MailMessage = { to: string; subject: string; text: string };

/** Sends plain-text email. Development and tests use the in-memory fake; nothing is ever really sent. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}
