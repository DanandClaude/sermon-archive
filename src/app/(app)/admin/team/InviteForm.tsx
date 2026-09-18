'use client';

import { useActionState } from 'react';
import { ROLES, ROLE_LABELS } from '@/lib/roles';
import { inviteMember, type TeamFormState } from './actions';

const inputClass =
  'box-border h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3.5 text-[15px] text-ink';

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-semibold">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-[13px] font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function InviteForm() {
  const [state, formAction, pending] = useActionState<TeamFormState, FormData>(inviteMember, {
    status: 'idle',
  });
  const errors = state.fieldErrors ?? {};
  const aria = (id: string) => ({
    'aria-invalid': errors[id] ? true : undefined,
    'aria-describedby': errors[id] ? `${id}-error` : undefined,
  });

  return (
    <form
      // Remounts after a successful invite so the fields clear.
      key={state.status === 'ok' ? state.message : 'form'}
      action={formAction}
      className="rounded-2xl border border-line bg-surface px-6 py-[22px]"
    >
      <h2 className="m-0 text-[17px] font-semibold">Add someone</h2>
      <p className="mt-1 text-[13px] text-muted">
        We email them a link to sign in. There are no passwords.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
        <Field id="name" label="Name" error={errors.name}>
          <input
            id="name"
            name="name"
            autoComplete="off"
            required
            className={inputClass}
            {...aria('name')}
          />
        </Field>
        <Field id="email" label="Email" error={errors.email}>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="off"
            required
            className={inputClass}
            {...aria('email')}
          />
        </Field>
        <Field id="locationLabel" label="Location" error={errors.locationLabel}>
          <input
            id="locationLabel"
            name="locationLabel"
            autoComplete="off"
            placeholder="City, State"
            className={inputClass}
            {...aria('locationLabel')}
          />
        </Field>
        <Field id="role" label="Role" error={errors.role}>
          <select
            id="role"
            name="role"
            defaultValue="contributor"
            className={inputClass}
            {...aria('role')}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white disabled:opacity-60"
        >
          {pending ? 'Adding…' : 'Add and email link'}
        </button>
        <p
          role="status"
          className={`m-0 text-[13px] font-semibold ${state.status === 'error' ? 'text-danger' : 'text-spruce'}`}
        >
          {state.message}
        </p>
      </div>
    </form>
  );
}
