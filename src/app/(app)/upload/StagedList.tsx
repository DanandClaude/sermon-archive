'use client';

import { formatBytes } from '@/lib/uploads/queue';

export type Staged = {
  id: string;
  file: File;
  side: 'A' | 'B' | '';
  overrides: { recordedOn: string; labelScripture: string; speaker: string; batchLabel: string };
  open: boolean;
  error?: string;
};

type Defaults = { recordedOn: string; labelScripture: string; speaker: string; batchLabel: string };

const small =
  'box-border h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3 text-[14px] text-ink';

export function StagedList({
  staged,
  defaults,
  totalBytes,
  onChange,
  onStart,
  onClear,
}: {
  staged: Staged[];
  defaults: Defaults;
  totalBytes: number;
  onChange: (next: Staged[]) => void;
  onStart: () => void;
  onClear: () => void;
}) {
  const update = (id: string, patch: Partial<Staged>) =>
    onChange(staged.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const setOverride = (s: Staged, field: keyof Staged['overrides'], value: string) =>
    update(s.id, { overrides: { ...s.overrides, [field]: value }, error: undefined });

  const fields: { field: keyof Staged['overrides']; label: string; placeholder: string }[] = [
    {
      field: 'recordedOn',
      label: 'Date on label',
      placeholder: defaults.recordedOn || 'MM/DD/YYYY',
    },
    {
      field: 'labelScripture',
      label: 'Scripture on label',
      placeholder: defaults.labelScripture || 'Hebrews 13:17',
    },
    { field: 'speaker', label: 'Speaker', placeholder: defaults.speaker },
    { field: 'batchLabel', label: 'Box or batch', placeholder: defaults.batchLabel || 'Box 3' },
  ];

  return (
    <section aria-labelledby="ready" className="rounded-2xl border border-line bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-chip px-6 pb-3.5 pt-[22px]">
        <h2 id="ready" className="m-0 text-[17px] font-semibold">
          Ready to upload{' '}
          <span className="font-normal text-muted">
            · {staged.length} file{staged.length === 1 ? '' : 's'}, {formatBytes(totalBytes)}
          </span>
        </h2>
        <span className="text-[13px] text-muted">
          Check each tape’s date and side, then upload.
        </span>
      </div>
      <ul className="m-0 list-none p-0">
        {staged.map((s) => (
          <li key={s.id} className="border-b border-chip px-6 py-3.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="min-w-0 flex-1 break-all font-mono text-[13px] font-medium">
                {s.file.name}
              </span>
              <span className="text-[13px] text-muted">{formatBytes(s.file.size)}</span>
              <label htmlFor={`side-${s.id}`} className="sr-only">
                Side of the tape for {s.file.name}
              </label>
              <select
                id={`side-${s.id}`}
                value={s.side}
                onChange={(e) => update(s.id, { side: e.target.value as Staged['side'] })}
                className="box-border h-11 rounded-[10px] border border-line-strong bg-surface px-3 text-[14px]"
              >
                <option value="">Side: not sure</option>
                <option value="A">Side A</option>
                <option value="B">Side B</option>
              </select>
              <button
                type="button"
                aria-expanded={s.open}
                onClick={() => update(s.id, { open: !s.open })}
                className="inline-flex h-11 items-center rounded-[10px] border border-line-strong bg-surface px-3.5 text-[13.5px] font-semibold"
              >
                {s.open ? 'Hide details' : 'Details'}
              </button>
              <button
                type="button"
                aria-label={`Remove ${s.file.name}`}
                onClick={() => onChange(staged.filter((x) => x.id !== s.id))}
                className="inline-flex h-11 items-center rounded-[10px] px-3 text-[13.5px] font-semibold text-muted"
              >
                Remove
              </button>
            </div>
            {s.open ? (
              <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                {fields.map(({ field, label, placeholder }) => (
                  <div key={field}>
                    <label
                      htmlFor={`${field}-${s.id}`}
                      className="mb-1 block text-[12.5px] font-semibold"
                    >
                      {label}
                    </label>
                    <input
                      id={`${field}-${s.id}`}
                      value={s.overrides[field]}
                      placeholder={placeholder}
                      onChange={(e) => setOverride(s, field, e.target.value)}
                      className={small}
                    />
                  </div>
                ))}
                <p className="m-0 text-[12.5px] text-muted sm:col-span-2">
                  Leave a field blank to use the tape details below.
                </p>
              </div>
            ) : null}
            {s.error ? (
              <p role="alert" className="mb-0 mt-2 text-[13px] font-semibold text-danger">
                {s.file.name}: {s.error}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3 px-6 py-4">
        <button
          type="button"
          onClick={onStart}
          className="inline-flex h-11 items-center rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white"
        >
          Upload {staged.length} file{staged.length === 1 ? '' : 's'}
        </button>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex h-11 items-center rounded-xl border border-line-strong bg-surface px-[18px] text-[14.5px] font-semibold"
        >
          Clear list
        </button>
      </div>
    </section>
  );
}
