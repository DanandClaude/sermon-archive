import { formatRecordedOn } from '@/lib/format';
import { formatReference, type Reference } from '@/lib/scripture/canon';

/** The sermon's details for someone who can look but not change them. */
export function ReadOnlyDetails({
  title,
  recordedOn,
  speaker,
  passage,
  tags,
  stem,
}: {
  title: string | null;
  recordedOn: string | null;
  speaker: string | null;
  passage: Reference | null;
  tags: string[];
  stem: string | null;
}) {
  return (
    <section
      aria-labelledby="details-h"
      className="rounded-2xl border border-line bg-surface px-[22px] py-5"
    >
      <h2 id="details-h" className="m-0 mb-3.5 text-[17px] font-semibold">
        Details
      </h2>
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted">Title</dt>
        <dd className="m-0">{title ?? '—'}</dd>
        <dt className="text-muted">Recorded</dt>
        <dd className="m-0">{formatRecordedOn(recordedOn) ?? '—'}</dd>
        <dt className="text-muted">Speaker</dt>
        <dd className="m-0">{speaker ?? '—'}</dd>
        <dt className="text-muted">Main passage</dt>
        <dd className="m-0">{passage ? formatReference(passage) : '—'}</dd>
        {stem ? (
          <>
            <dt className="text-muted">File name</dt>
            <dd className="m-0 break-all font-mono text-[12.5px]">{stem}</dd>
          </>
        ) : null}
      </dl>
      {tags.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex h-[30px] items-center rounded-full bg-chip px-3 text-[13px]"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
