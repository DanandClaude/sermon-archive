import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import {
  getLibrarySermon,
  LIBRARY_PATH,
  libraryAudioPath,
  type LibrarySermon,
} from '@/lib/distribution/library';
import { formatRecordedOn } from '@/lib/format';
import { isUuid } from '@/lib/sermons/detail';
import { ListenPlayer } from './ListenPlayer';

async function load(id: string): Promise<LibrarySermon | null> {
  return isUuid(id) ? getLibrarySermon(getDb(), id) : null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const sermon = await load((await params).id);
  if (!sermon) return { title: 'Not found' };
  const { entry } = sermon;
  return {
    title: { absolute: entry.title },
    description: entry.summary ?? undefined,
  };
}

export default async function LibrarySermonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sermon = await load(id);
  if (!sermon) notFound();
  const { entry, passages, segments } = sermon;

  return (
    <article>
      <Link href={LIBRARY_PATH} className="text-[13.5px] font-semibold text-spruce">
        ← All sermons
      </Link>
      <h1 className="mb-0 mt-3 font-heading text-[30px] font-semibold leading-[1.15]">
        {entry.title}
      </h1>
      <p className="mb-0 mt-2 flex flex-wrap gap-x-3 text-[14px] text-muted">
        {entry.passage ? <span className="font-semibold text-spruce">{entry.passage}</span> : null}
        {entry.recordedOn ? <span>{formatRecordedOn(entry.recordedOn)}</span> : null}
        {entry.speaker ? <span>{entry.speaker}</span> : null}
      </p>

      <ListenPlayer
        src={libraryAudioPath(entry.id)}
        durationSec={entry.durationSec}
        summary={entry.summary}
        passages={passages}
        segments={segments.map((s) => ({ start: s.start, text: s.text }))}
      />
    </article>
  );
}
