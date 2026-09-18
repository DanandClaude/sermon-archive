'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/icons';
import { UploadManager, type UploadItem } from '@/lib/uploads/client';
import { browserDeps } from '@/lib/uploads/browser';
import { detectSide, parseLabelDate } from '@/lib/uploads/label';
import {
  mergeQueue,
  formatBytes,
  type LocalUpload,
  type ServerQueueItem,
} from '@/lib/uploads/queue';
import { MAX_FILE_BYTES } from '@/lib/uploads/limits';
import { EXTENSION_FORMAT, extensionOf } from '@/lib/uploads/sniff';
import { QueuePanel } from './QueuePanel';
import { StagedList, type Staged } from './StagedList';

const ALLOWED = new Set(Object.keys(EXTENSION_FORMAT));
const inputClass =
  'box-border h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3.5 text-[15px] text-ink';

type Defaults = { recordedOn: string; labelScripture: string; speaker: string; batchLabel: string };
const key = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

export function UploadClient({
  defaultSpeaker,
  initialQueue,
}: {
  defaultSpeaker: string;
  initialQueue: ServerQueueItem[];
}) {
  const [defaults, setDefaults] = useState<Defaults>({
    recordedOn: '',
    labelScripture: '',
    speaker: defaultSpeaker,
    batchLabel: '',
  });
  const [defaultsError, setDefaultsError] = useState<string>();
  const [staged, setStaged] = useState<Staged[]>([]);
  const [local, setLocal] = useState<Record<string, LocalUpload>>({});
  const [serverItems, setServerItems] = useState<ServerQueueItem[]>(initialQueue);
  const [notices, setNotices] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const router = useRouter();
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const manager = useMemo(
    () =>
      new UploadManager(browserDeps, (id, state) =>
        setLocal((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], state } } : prev)),
      ),
    [],
  );

  const refreshQueue = useCallback(async () => {
    try {
      const res = await fetch('/api/queue', { credentials: 'same-origin' });
      if (res.status === 401) return router.push('/sign-in?next=/upload');
      if (res.ok) setServerItems((await res.json()).items);
    } catch {
      // Offline for a moment; the next poll will catch up.
    }
  }, [router]);

  // The server supplies the first queue, so this only keeps it fresh.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void refreshQueue();
    }, 4000);
    return () => clearInterval(timer);
  }, [refreshQueue]);

  const addFiles = (files: File[]) => {
    const rejected: string[] = [];
    const taken = new Set([
      ...staged.map((s) => key(s.file)),
      ...Object.values(local).map((l) => `${l.name}|${l.state.totalBytes}`),
    ]);
    const added: Staged[] = [];
    for (const file of files) {
      if (!ALLOWED.has(extensionOf(file.name))) {
        rejected.push(`${file.name} isn’t an MP3, WAV, M4A, AIFF or FLAC file.`);
      } else if (file.size === 0) {
        rejected.push(`${file.name} is empty.`);
      } else if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name} is over 2 GB.`);
      } else if (!taken.has(key(file))) {
        taken.add(key(file));
        added.push({
          id: crypto.randomUUID(),
          file,
          side: detectSide(file.name) ?? '',
          overrides: { recordedOn: '', labelScripture: '', speaker: '', batchLabel: '' },
          open: false,
        });
      }
    }
    added.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true }));
    setStaged((prev) => [...prev, ...added]);
    setNotices([
      ...(added.length ? [`${added.length} file${added.length === 1 ? '' : 's'} added.`] : []),
      ...rejected,
    ]);
  };

  const startUploads = () => {
    let invalid = false;
    const checked = staged.map((s) => {
      const text = s.overrides.recordedOn.trim() || defaults.recordedOn.trim();
      if (!text) return { s, iso: undefined, error: undefined };
      const parsed = parseLabelDate(text);
      if (parsed.ok) return { s, iso: parsed.iso, error: undefined };
      invalid = true;
      return { s, iso: undefined, error: parsed.error };
    });
    const defaultText = defaults.recordedOn.trim();
    setDefaultsError(
      defaultText && !parseLabelDate(defaultText).ok
        ? (parseLabelDate(defaultText) as { error: string }).error
        : undefined,
    );
    setStaged(
      checked.map(({ s, error }) => ({
        ...s,
        error,
        open: s.open || Boolean(error && s.overrides.recordedOn.trim()),
      })),
    );
    if (invalid) return;

    const items: UploadItem[] = checked.map(({ s, iso }) => ({
      id: s.id,
      file: s.file,
      details: {
        recordedOn: iso,
        labelScripture: s.overrides.labelScripture.trim() || defaults.labelScripture.trim(),
        speaker: s.overrides.speaker.trim() || defaults.speaker.trim(),
        batchLabel: s.overrides.batchLabel.trim() || defaults.batchLabel.trim(),
        side: s.side || null,
      },
    }));
    setLocal((prev) => ({
      ...prev,
      ...Object.fromEntries(
        items.map((i) => [
          i.id,
          {
            name: i.file.name,
            state: { status: 'waiting' as const, sentBytes: 0, totalBytes: i.file.size },
          },
        ]),
      ),
    }));
    setStaged([]);
    setNotices([]);
    void manager.run(items).then(refreshQueue);
  };

  const dismiss = (localId: string) =>
    setLocal((prev) => {
      const next = { ...prev };
      delete next[localId];
      return next;
    });

  const rows = mergeQueue(serverItems, local);
  const totalStaged = staged.reduce((sum, s) => sum + s.file.size, 0);

  return (
    <div className="flex min-h-0 flex-col gap-7 xl:flex-row">
      <section aria-label="Upload" className="flex min-w-0 flex-1 flex-col gap-5">
        <div
          onDragOver={(e) => (e.preventDefault(), setDragging(true))}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            addFiles([...e.dataTransfer.files]);
          }}
          className={`flex flex-col items-center gap-1.5 rounded-[20px] border-2 border-dashed px-6 py-7 text-center ${
            dragging ? 'border-spruce bg-spruce-tint' : 'border-[#b9ae9a] bg-paper'
          }`}
        >
          <div className="mb-1.5 flex h-14 w-14 items-center justify-center rounded-full bg-spruce-tint text-spruce">
            <Icon name="upload" size={26} />
          </div>
          <div className="font-heading text-2xl font-semibold">Drop tape recordings here</div>
          <div className="text-[14.5px] text-muted">
            MP3, WAV, M4A, AIFF or FLAC · Side A and Side B can go up together
          </div>
          <div className="mt-3.5 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={() => filesInput.current?.click()}
              className="inline-flex h-11 items-center rounded-xl bg-spruce px-5 text-[14.5px] font-semibold text-white"
            >
              Choose files
            </button>
            <button
              type="button"
              onClick={() => folderInput.current?.click()}
              className="inline-flex h-11 items-center rounded-xl border border-line-strong bg-surface px-[18px] text-[14.5px] font-semibold text-ink"
            >
              Choose a folder
            </button>
          </div>
          <input
            ref={filesInput}
            type="file"
            multiple
            hidden
            aria-label="Choose audio files"
            accept=".mp3,.wav,.m4a,.aiff,.aif,.flac,audio/*"
            onChange={(e) => (addFiles([...(e.target.files ?? [])]), (e.target.value = ''))}
          />
          <input
            ref={folderInput}
            type="file"
            hidden
            aria-label="Choose a folder of audio files"
            {...({ webkitdirectory: '' } as object)}
            onChange={(e) => (addFiles([...(e.target.files ?? [])]), (e.target.value = ''))}
          />
        </div>

        <div
          role="status"
          aria-live="polite"
          className={
            notices.length
              ? 'rounded-xl bg-amber-tint px-4 py-3 text-[13.5px] text-amber-text'
              : 'sr-only'
          }
        >
          {notices.map((n) => (
            <p key={n} className="m-0">
              {n}
            </p>
          ))}
        </div>

        {staged.length > 0 ? (
          <StagedList
            staged={staged}
            defaults={defaults}
            totalBytes={totalStaged}
            onChange={(next) => setStaged(next)}
            onStart={startUploads}
            onClear={() => setStaged([])}
          />
        ) : null}

        <section
          aria-labelledby="tape-details"
          className="rounded-2xl border border-line bg-surface px-6 py-[22px]"
        >
          <div className="flex items-baseline justify-between">
            <h2 id="tape-details" className="m-0 text-[17px] font-semibold">
              Tape details{' '}
              <span className="font-normal text-muted">
                · applies to every file unless you change it
              </span>
            </h2>
            <span className="text-[13px] text-muted">Optional</span>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2">
            <div>
              <label htmlFor="tape-date" className="mb-1.5 block text-[13px] font-semibold">
                Date on tape label
              </label>
              <input
                id="tape-date"
                value={defaults.recordedOn}
                placeholder="MM/DD/YYYY"
                inputMode="numeric"
                onChange={(e) => setDefaults({ ...defaults, recordedOn: e.target.value })}
                aria-invalid={defaultsError ? true : undefined}
                aria-describedby={defaultsError ? 'tape-date-error' : undefined}
                className={inputClass}
              />
              {defaultsError ? (
                <p id="tape-date-error" className="mt-1 text-[13px] font-semibold text-danger">
                  {defaultsError}
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor="tape-scripture" className="mb-1.5 block text-[13px] font-semibold">
                Scripture on label
              </label>
              <input
                id="tape-scripture"
                value={defaults.labelScripture}
                placeholder="Hebrews 13:17"
                onChange={(e) => setDefaults({ ...defaults, labelScripture: e.target.value })}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="tape-speaker" className="mb-1.5 block text-[13px] font-semibold">
                Speaker
              </label>
              <input
                id="tape-speaker"
                value={defaults.speaker}
                onChange={(e) => setDefaults({ ...defaults, speaker: e.target.value })}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="tape-box" className="mb-1.5 block text-[13px] font-semibold">
                Tape box or batch
              </label>
              <input
                id="tape-box"
                value={defaults.batchLabel}
                placeholder="Box 3"
                onChange={(e) => setDefaults({ ...defaults, batchLabel: e.target.value })}
                className={inputClass}
              />
            </div>
          </div>
          <p className="mb-0 mt-3.5 text-[13px] text-muted">
            Trust the label over the recording: what you type here is used as-is. Leave anything
            blank and we’ll try to detect the date and scripture from the audio.
          </p>
        </section>

        <section
          aria-labelledby="after-upload"
          className="rounded-2xl border border-line bg-surface px-6 py-[22px]"
        >
          <h2 id="after-upload" className="m-0 mb-3.5 text-[17px] font-semibold">
            What happens after upload
          </h2>
          <ul className="m-0 grid list-none grid-cols-1 gap-x-5 gap-y-3.5 p-0 sm:grid-cols-2">
            {[
              ['Clean up audio', 'Reduce hiss and hum, and even out the volume.'],
              ['Transcribe', 'Speaker profile: American English, Southern accent.'],
              [
                'Name, categorize & summarize',
                'Names files YYYY-MM-DD_Book-Chapter-Verse_ShortTitle, adds tags and a short summary, and lists the Bible passages the pastor names, with timestamps.',
              ],
              [
                'File & back up',
                'Saves to the shared drive and the admin-only backup once you approve.',
              ],
            ].map(([title, body]) => (
              <li key={title} className="flex items-start gap-3">
                <span className="mt-0.5 text-spruce">
                  <Icon name="review" size={20} />
                </span>
                <div>
                  <div className="text-[14.5px] font-semibold">{title}</div>
                  <div className="mt-0.5 text-[13px] leading-[1.45] text-muted">{body}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </section>

      <QueuePanel
        rows={rows}
        onCancel={(row) =>
          row.localId &&
          void manager.cancel(row.localId, local[row.localId]?.state.uploadId).then(refreshQueue)
        }
        onDismiss={(row) => row.localId && dismiss(row.localId)}
      />
    </div>
  );
}

export { formatBytes };
