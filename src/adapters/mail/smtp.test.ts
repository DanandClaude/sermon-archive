import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeMailer } from './fake';
import { SmtpMailer } from './smtp';

let server: SMTPServer;
let port: number;
const received: string[] = [];

beforeAll(async () => {
  server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    onData(stream, _session, done) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'));
        done();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('SmtpMailer', () => {
  it('delivers a message to an SMTP server with the configured sender', async () => {
    const mailer = new SmtpMailer(
      `smtp://127.0.0.1:${port}`,
      'Sermon Archive <archive@example.test>',
    );
    await mailer.send({
      to: 'marcy@example.test',
      subject: 'Hello there',
      text: 'Your link is ready.',
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('From: Sermon Archive <archive@example.test>');
    expect(received[0]).toContain('To: marcy@example.test');
    expect(received[0]).toContain('Subject: Hello there');
    expect(received[0]).toContain('Your link is ready.');
  });

  it('fails loudly when the server is unreachable', async () => {
    const mailer = new SmtpMailer('smtp://127.0.0.1:1', 'a@example.test');
    await expect(mailer.send({ to: 'b@example.test', subject: 's', text: 't' })).rejects.toThrow();
  });
});

describe('FakeMailer', () => {
  it('keeps what it was asked to send', async () => {
    const mailer = new FakeMailer();
    await mailer.send({ to: 'a@example.test', subject: 's', text: 't' });
    expect(mailer.outbox.map((m) => m.to)).toEqual(['a@example.test']);
  });
});
