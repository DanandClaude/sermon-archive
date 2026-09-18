import { notFound } from 'next/navigation';
import { getMailer } from '@/adapters';
import { FakeMailer } from '@/adapters/mail/fake';

export const metadata = { title: 'Dev outbox' };

/** Development only. Lists the emails the fake mailer "sent" so sign-in links can be clicked. */
export default async function DevOutbox() {
  if (process.env.NODE_ENV !== 'development') notFound();
  const mailer = getMailer();
  const messages = mailer instanceof FakeMailer ? [...mailer.outbox].reverse() : [];
  return (
    <main className="mx-auto max-w-[720px] px-4 py-10">
      <h1 className="font-heading text-[28px] font-semibold">Dev outbox</h1>
      <p className="mt-2 text-muted">
        Emails the fake mailer has “sent” since the server started. Development only.
      </p>
      {messages.length === 0 ? <p className="mt-6">Nothing sent yet.</p> : null}
      {messages.map((m, i) => (
        <article key={i} className="mt-6 rounded-2xl border border-line bg-surface p-5">
          <div className="text-[13px] text-muted">
            To {m.to} · {m.sentAt.toLocaleTimeString()}
          </div>
          <h2 className="mt-1 text-[17px] font-semibold">{m.subject}</h2>
          <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-[14px]">
            {m.text.split(/(https?:\/\/\S+)/).map((part, j) =>
              /^https?:\/\//.test(part) ? (
                <a key={j} href={part} className="text-spruce underline">
                  {part}
                </a>
              ) : (
                part
              ),
            )}
          </pre>
        </article>
      ))}
    </main>
  );
}
