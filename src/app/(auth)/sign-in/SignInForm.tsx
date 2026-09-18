'use client';

import { useActionState } from 'react';
import { requestLink, type SignInState } from '@/lib/auth/actions';

export function SignInForm({ next, expired }: { next: string; expired: boolean }) {
  const [state, formAction, pending] = useActionState<SignInState, FormData>(requestLink, {
    status: 'idle',
    email: '',
  });

  if (state.status === 'sent') {
    return (
      <div>
        <h1 className="m-0 font-heading text-[28px] font-semibold leading-[1.15]">
          Check your email
        </h1>
        <p className="mt-3 text-[15px] leading-normal text-muted">
          If <strong className="text-ink">{state.email}</strong> is on the team, a sign-in link is
          on its way. It works once and expires in 15 minutes.
        </p>
        <p className="mt-4 text-[13px] text-muted">
          Nothing arrived? Check your spam folder, or ask an admin at your church to add you.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction}>
      <h1 className="m-0 font-heading text-[28px] font-semibold leading-[1.15]">Sign in</h1>
      <p className="mt-3 text-[15px] leading-normal text-muted">
        {expired
          ? 'That link has expired or was already used. Enter your email to get a new one.'
          : 'Enter your email and we’ll send you a link. No password needed.'}
      </p>
      <input type="hidden" name="next" value={next} />
      <label htmlFor="email" className="mb-1.5 mt-6 block text-[13px] font-semibold">
        Email
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        defaultValue={state.email}
        aria-invalid={state.status === 'error' ? true : undefined}
        aria-describedby={state.status === 'error' ? 'email-error' : undefined}
        className="box-border h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3.5 text-[15px] text-ink"
      />
      {state.status === 'error' ? (
        <p id="email-error" role="alert" className="mt-1.5 text-[13px] font-semibold text-danger">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="mt-5 inline-flex h-11 w-full items-center justify-center rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white disabled:opacity-60"
      >
        {pending ? 'Sending…' : 'Email me a link'}
      </button>
    </form>
  );
}
