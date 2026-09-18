import { AdminOnlyBadge, PageHeader } from '@/components/shell/PageHeader';
import { getDb } from '@/db/client';
import { requireCapability } from '@/lib/auth/guard';
import { listTeam } from '@/lib/team';
import { InviteForm } from './InviteForm';
import { MemberRow, type MemberView } from './MemberRow';

export const metadata = { title: 'Team & access' };

export default async function TeamPage() {
  const user = await requireCapability('team.manage');
  const team = await listTeam(getDb(), user);
  const members: MemberView[] = team.map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    role: m.role,
    locationLabel: m.locationLabel,
    status: m.disabledAt ? 'disabled' : m.lastSignInAt ? 'active' : 'invited',
    isYou: m.id === user.id,
  }));

  return (
    <>
      <PageHeader
        title="Team & access"
        description="Add the people who upload, review and browse sermons, and choose what each of them can do."
        aside={<AdminOnlyBadge />}
      />
      <InviteForm />
      <section
        aria-labelledby="people"
        className="overflow-hidden rounded-2xl border border-line bg-surface"
      >
        <h2
          id="people"
          className="m-0 border-b border-chip px-6 pb-4 pt-[22px] text-[17px] font-semibold"
        >
          People <span className="font-normal text-muted">· {members.length}</span>
        </h2>
        <ul className="m-0 list-none p-0">
          {members.map((m) => (
            <MemberRow key={m.id} member={m} />
          ))}
        </ul>
        <div className="grid gap-2 border-t border-chip bg-paper px-6 py-4 text-[13px] text-muted sm:grid-cols-3">
          <div>
            <strong className="text-ink">Admin</strong> manages storage, backup, publishing and the
            team.
          </div>
          <div>
            <strong className="text-ink">Contributor</strong> uploads, reviews and approves their
            own sermons.
          </div>
          <div>
            <strong className="text-ink">Viewer</strong> browses approved sermons.
          </div>
        </div>
      </section>
    </>
  );
}
