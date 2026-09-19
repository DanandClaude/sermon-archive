/** What approving does, or, once approved, what happened. */
export function ApproveCard({
  approved,
  approvedAt,
  approverName,
  stem,
}: {
  approved: boolean;
  approvedAt: Date | null;
  approverName: string | null;
  stem: string | null;
}) {
  const when = approvedAt
    ? approvedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;
  return (
    <section
      aria-labelledby="approve-h"
      className="rounded-2xl border border-line bg-surface px-[22px] py-5"
    >
      <h2 id="approve-h" className="m-0 mb-3.5 text-[17px] font-semibold">
        {approved ? 'Approved' : 'When you approve'}
      </h2>
      {approved ? (
        <p className="m-0 text-sm leading-[1.5]">
          Approved{approverName ? ` by ${approverName}` : ''}
          {when ? ` on ${when}` : ''}. It is named{' '}
          <span className="break-all font-mono text-[12.5px]">{stem}</span>.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0 text-sm leading-[1.5]">
          <li>The sermon gets its file name and is marked Approved.</li>
          <li>Everyone who can use the library can then find and play it.</li>
          <li className="text-muted">
            Filing to the shared drive and the admin backup isn’t connected yet. Approved sermons
            are filed once it is.
          </li>
        </ul>
      )}
    </section>
  );
}
