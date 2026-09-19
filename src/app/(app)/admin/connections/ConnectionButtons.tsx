'use client';

import { useState, useTransition } from 'react';
import {
  connectDevFolderAction,
  disconnectAction,
  fileWaitingAction,
  verifyNowAction,
  type StorageActionResult,
} from './actions';

const secondary =
  'inline-flex h-11 items-center justify-center rounded-xl border border-line-strong bg-surface px-4 text-sm font-semibold text-ink disabled:opacity-60';
const primary =
  'inline-flex h-11 items-center justify-center rounded-xl bg-spruce px-[18px] text-sm font-semibold text-white disabled:opacity-60';

/** Runs an action and shows what came back, so the admin always sees the outcome. */
function useAction() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<StorageActionResult | null>(null);
  const run = (work: () => Promise<StorageActionResult>, after?: () => void) =>
    start(async () => {
      const outcome = await work();
      setResult(outcome);
      if (outcome.ok) after?.();
    });
  const note = result ? (
    <p
      role={result.ok ? 'status' : 'alert'}
      className={`m-0 text-[13px] font-semibold ${result.ok ? 'text-spruce' : 'text-danger'}`}
    >
      {result.ok ? result.message : result.error}
    </p>
  ) : null;
  return { pending, run, note };
}

export function ConnectButtons({
  role,
  label,
  connected,
  realMode,
}: {
  role: 'shared' | 'backup';
  label: string;
  connected: boolean;
  realMode: boolean;
}) {
  const { pending, run, note } = useAction();
  const [confirming, setConfirming] = useState(false);

  if (!connected) {
    return (
      <div className="mt-2 flex flex-col gap-2">
        {realMode ? (
          <a
            href={`/api/connections/google/start?role=${role}`}
            className={`${primary} self-start`}
          >
            Connect Google Drive
          </a>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => connectDevFolderAction(role))}
            className={`${primary} self-start`}
          >
            Use a development folder
          </button>
        )}
        <p className="m-0 text-[12.5px] leading-[1.45] text-muted">
          {realMode
            ? `Sign in with the Google account that should hold the ${label}. Use a different account from the other one.`
            : 'Development mode files to a folder on this computer. Nothing goes to Google.'}
        </p>
        {note}
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      {confirming ? (
        <div className="rounded-xl bg-amber-tint px-3.5 py-3 text-[13.5px] text-amber-text">
          <p className="m-0">
            Disconnect the {label}? Files already there stay where they are. New sermons can’t be
            filed until it is connected again.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(
                  () => disconnectAction(role),
                  () => setConfirming(false),
                )
              }
              className="h-11 rounded-xl bg-danger px-4 text-sm font-semibold text-white disabled:opacity-60"
            >
              Disconnect
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="h-11 px-3 text-sm font-semibold text-spruce"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {realMode ? (
            <a href={`/api/connections/google/start?role=${role}`} className={secondary}>
              Reconnect account
            </a>
          ) : null}
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="h-11 px-3 text-sm font-semibold text-danger"
          >
            Disconnect
          </button>
        </div>
      )}
      {note}
    </div>
  );
}

export function CheckButtons({
  waiting,
  canFile,
  checking,
}: {
  waiting: number;
  canFile: boolean;
  checking: boolean;
}) {
  const { pending, run, note } = useAction();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending || checking}
          onClick={() => run(verifyNowAction)}
          className={secondary}
        >
          {checking ? 'Checking…' : 'Verify now'}
        </button>
        {waiting > 0 ? (
          <button
            type="button"
            disabled={pending || !canFile}
            onClick={() => run(fileWaitingAction)}
            className={primary}
          >
            File {waiting} waiting {waiting === 1 ? 'sermon' : 'sermons'}
          </button>
        ) : null}
      </div>
      {waiting > 0 && !canFile ? (
        <p className="m-0 text-[13px] text-muted">Connect both places first, then file them.</p>
      ) : null}
      {note}
    </div>
  );
}
