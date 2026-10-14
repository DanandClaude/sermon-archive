'use client';

import { useRouter } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { browserDeps } from '@/lib/uploads/browser';
import { UploadManager, type ItemState } from '@/lib/uploads/client';
import { MAX_FILE_BYTES } from '@/lib/uploads/limits';
import { percentOf } from '@/lib/uploads/queue';
import { EXTENSION_FORMAT, extensionOf } from '@/lib/uploads/sniff';

const ACCEPT = Object.keys(EXTENSION_FORMAT)
  .map((ext) => `.${ext}`)
  .join(',');
const ACTIVE = new Set(['waiting', 'starting', 'uploading', 'finishing']);

/** Shown while a sermon waits for the full recording after its audio was rejected. */
export function ReplaceAudioCard({
  sermonId,
  reason,
  canReplace,
}: {
  sermonId: string;
  reason: string | null;
  canReplace: boolean;
}) {
  const router = useRouter();
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<ItemState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const manager = useMemo(
    () =>
      new UploadManager(browserDeps, (_, next) => {
        setState(next);
        if (next.status === 'done') router.refresh();
      }),
    [router],
  );
  const busy = state !== null && ACTIVE.has(state.status);

  function choose(chosen: File | undefined) {
    setState(null);
    setProblem(null);
    setFile(null);
    if (!chosen) return;
    if (!(extensionOf(chosen.name) in EXTENSION_FORMAT)) {
      return setProblem(`${chosen.name} isn’t an MP3, WAV, M4A, AIFF or FLAC file.`);
    }
    if (chosen.size === 0) return setProblem(`${chosen.name} is empty.`);
    if (chosen.size > MAX_FILE_BYTES) return setProblem(`${chosen.name} is over 2 GB.`);
    setFile(chosen);
  }

  function upload() {
    if (!file) return;
    void manager.run([{ id: 'replacement', file, details: {}, replacesSermonId: sermonId }]);
  }

  return (
    <section
      aria-labelledby="replace-h"
      className="rounded-2xl border border-[#e8c5be] bg-[#f8e6e2] px-6 py-[22px]"
    >
      <h2 id="replace-h" className="m-0 text-[17px] font-semibold text-danger">
        This recording was rejected
      </h2>
      <p className="mb-0 mt-1.5 text-[14.5px]">
        {reason ?? 'The recording was incomplete.'} It has been set aside, not deleted. Upload the
        full recording and it will be processed again. The details already entered are kept.
      </p>

      {canReplace ? (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <label
              htmlFor={inputId}
              className="inline-flex h-11 cursor-pointer items-center rounded-xl border border-line-strong bg-surface px-[18px] text-[14.5px] font-semibold text-ink"
            >
              {file ? 'Choose a different file' : 'Choose the full recording'}
            </label>
            <input
              id={inputId}
              type="file"
              accept={ACCEPT}
              disabled={busy}
              onChange={(e) => choose(e.target.files?.[0])}
              className="sr-only"
            />
            {file ? (
              <button
                type="button"
                onClick={upload}
                disabled={busy || state?.status === 'done'}
                className="inline-flex h-11 items-center rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white disabled:opacity-60"
              >
                {busy ? 'Uploading…' : 'Upload'}
              </button>
            ) : null}
          </div>
          {file ? <p className="m-0 break-all font-mono text-[12.5px]">{file.name}</p> : null}
          {state && busy ? (
            <div
              role="progressbar"
              aria-label="Upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percentOf(state)}
              className="h-1.5 overflow-hidden rounded-[3px] bg-line"
            >
              <div className="h-full bg-amber" style={{ width: `${percentOf(state)}%` }} />
            </div>
          ) : null}
          {state?.status === 'done' ? (
            <p role="status" className="m-0 text-[13.5px] font-semibold text-spruce">
              Uploaded. Processing starts again from the beginning.
            </p>
          ) : null}
          {problem || state?.status === 'error' ? (
            <p role="alert" className="m-0 text-[13.5px] font-semibold text-danger">
              {problem ?? state?.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
