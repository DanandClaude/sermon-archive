'use client';

import { useActionState } from 'react';
import { saveProfile, type ProfileFormState } from './actions';

const inputClass =
  'box-border h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3.5 text-[15px] text-ink';

export function ProfileForm({
  initial,
  email,
  roleLabel,
}: {
  initial: { name: string; locationLabel: string };
  email: string;
  roleLabel: string;
}) {
  const [state, formAction, pending] = useActionState<ProfileFormState, FormData>(saveProfile, {
    status: 'idle',
    values: initial,
  });
  const errors = state.fieldErrors ?? {};

  return (
    <form
      action={formAction}
      className="flex max-w-[560px] flex-col gap-5 rounded-2xl border border-line bg-surface px-6 py-[22px]"
    >
      <div>
        <label htmlFor="name" className="mb-1.5 block text-[13px] font-semibold">
          Name
        </label>
        <input
          id="name"
          name="name"
          defaultValue={state.values.name}
          required
          className={inputClass}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? 'name-error' : undefined}
        />
        {errors.name ? (
          <p id="name-error" className="mt-1 text-[13px] font-semibold text-danger">
            {errors.name}
          </p>
        ) : null}
      </div>
      <div>
        <label htmlFor="locationLabel" className="mb-1.5 block text-[13px] font-semibold">
          Location
        </label>
        <input
          id="locationLabel"
          name="locationLabel"
          defaultValue={state.values.locationLabel}
          placeholder="City, State"
          className={inputClass}
          aria-invalid={errors.locationLabel ? true : undefined}
          aria-describedby={errors.locationLabel ? 'location-error' : undefined}
        />
        {errors.locationLabel ? (
          <p id="location-error" className="mt-1 text-[13px] font-semibold text-danger">
            {errors.locationLabel}
          </p>
        ) : null}
      </div>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[14px]">
        <dt className="text-muted">Email</dt>
        <dd className="m-0">{email}</dd>
        <dt className="text-muted">Role</dt>
        <dd className="m-0">{roleLabel}</dd>
      </dl>
      <p className="m-0 text-[13px] text-muted">To change your email or role, ask an admin.</p>
      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
        <p role="status" className="m-0 text-[13px] font-semibold text-spruce">
          {state.status === 'saved' ? 'Saved.' : ''}
        </p>
      </div>
    </form>
  );
}
