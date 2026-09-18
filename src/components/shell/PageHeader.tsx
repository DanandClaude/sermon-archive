import { Icon } from '@/components/icons';

export function PageHeader({
  title,
  description,
  aside,
}: {
  title: string;
  description?: string;
  aside?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-[min(100%,20rem)] flex-1">
        <h1 className="m-0 font-heading text-[38px] font-semibold leading-[1.1] tracking-[-0.01em]">
          {title}
        </h1>
        {description ? (
          <p className="mt-2.5 max-w-[600px] text-base leading-normal text-muted">{description}</p>
        ) : null}
      </div>
      {aside}
    </header>
  );
}

export function AdminOnlyBadge() {
  return (
    <span className="inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-[13px] text-muted">
      <Icon name="lock" size={18} />
      Admin only
    </span>
  );
}

/** Stand-in body for screens built in a later phase. */
export function ComingSoon({ phase }: { phase: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-paper px-6 py-10 text-center text-muted">
      This screen is built in {phase}.
    </div>
  );
}
