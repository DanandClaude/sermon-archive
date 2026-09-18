'use client';

import { useActionState } from 'react';
import { initials } from '@/lib/initials';
import { ROLES, ROLE_LABELS, type Role } from '@/lib/roles';
import { manageMember, type TeamFormState } from './actions';

export type MemberView = {
  id: string;
  name: string;
  email: string;
  role: Role;
  locationLabel: string | null;
  status: 'active' | 'invited' | 'disabled';
  isYou: boolean;
};

const STATUS_STYLE = {
  active: 'bg-spruce-tint text-spruce',
  invited: 'bg-amber-tint text-amber-text',
  disabled: 'bg-chip text-muted',
} as const;
const STATUS_LABEL = { active: 'Active', invited: 'Invited', disabled: 'Disabled' } as const;

const buttonClass =
  'inline-flex h-11 items-center rounded-[10px] border border-line-strong bg-surface px-3.5 text-[13.5px] font-semibold text-ink disabled:opacity-60';

export function MemberRow({ member }: { member: MemberView }) {
  const [state, formAction, pending] = useActionState<TeamFormState, FormData>(manageMember, {
    status: 'idle',
  });

  return (
    <li className="border-b border-chip px-6 py-4 last:border-b-0">
      <form action={formAction} className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <input type="hidden" name="userId" value={member.id} />
        <div
          aria-hidden="true"
          className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-spruce-tint text-[13px] font-bold text-spruce"
        >
          {initials(member.name)}
        </div>
        <div className="min-w-[180px] flex-1">
          <div className="text-[14.5px] font-semibold">
            {member.name}
            {member.isYou ? <span className="ml-2 font-normal text-muted">(you)</span> : null}
          </div>
          <div className="text-[13px] text-muted">
            {member.email}
            {member.locationLabel ? ` · ${member.locationLabel}` : ''}
          </div>
        </div>
        <span
          className={`inline-flex h-[26px] items-center rounded-full px-2.5 text-[12.5px] font-semibold ${STATUS_STYLE[member.status]}`}
        >
          {STATUS_LABEL[member.status]}
        </span>
        <div className="flex items-center gap-2">
          <label htmlFor={`role-${member.id}`} className="sr-only">
            Role for {member.name}
          </label>
          <select
            id={`role-${member.id}`}
            name="role"
            defaultValue={member.role}
            className="box-border h-11 rounded-[10px] border border-line-strong bg-surface px-3 text-[14px]"
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
          <button
            type="submit"
            name="intent"
            value="role"
            disabled={pending}
            className={buttonClass}
          >
            Save role
          </button>
        </div>
        <div className="flex items-center gap-2">
          {member.status === 'invited' ? (
            <button
              type="submit"
              name="intent"
              value="resend"
              disabled={pending}
              className={buttonClass}
            >
              Resend invite
            </button>
          ) : null}
          {member.status === 'disabled' ? (
            <button
              type="submit"
              name="intent"
              value="enable"
              disabled={pending}
              className={buttonClass}
            >
              Enable
            </button>
          ) : (
            <button
              type="submit"
              name="intent"
              value="disable"
              disabled={pending}
              className={`${buttonClass} text-danger`}
            >
              Disable
            </button>
          )}
        </div>
      </form>
      <p
        role="status"
        className={`mb-0 mt-2 pl-14 text-[13px] font-semibold ${state.status === 'error' ? 'text-danger' : 'text-spruce'}`}
      >
        {state.message}
      </p>
    </li>
  );
}
